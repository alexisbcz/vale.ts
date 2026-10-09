/**
 * The tree-walking interpreter.
 *
 * This is not a port of Tengo's VM -- there is no bytecode and no stack
 * machine -- but it has to agree with it on every observable answer, so the
 * operator table below is a transcription of the `BinaryOp` methods in Tengo's
 * `objects.go` rather than of the operator documentation, which is wrong about
 * float-and-int arithmetic in both directions.
 *
 * # Scopes
 *
 * Scopes nest per block, as Tengo's symbol table does: an `if` or `for` body
 * is its own scope, so `:=` inside one shadows rather than clashes. A variable
 * is a box rather than a slot in a map, so a closure that captures one sees
 * later writes to it.
 *
 * # The deadline
 *
 * `tick` is called on every loop iteration and every call, and samples the
 * clock every 256 ticks. A runaway loop therefore ends within a few hundred
 * iterations of its deadline no matter how tight its body is, which is the
 * property a wall-clock check at statement granularity would not have.
 */

import type { BlockStmt, Expr, Program, Stmt } from "./ast.ts";
import { BUILTINS } from "./builtins.ts";
import { fmtModule } from "./stdlib/fmt.ts";
import { mathModule } from "./stdlib/math.ts";
import { textModule } from "./stdlib/text.ts";
import type { Value } from "./values.ts";
import {
	display,
	equals,
	freezeShallow,
	makeArray,
	makeBool,
	makeBytes,
	makeChar,
	makeError,
	makeFloat,
	makeInt,
	makeMap,
	makeString,
	type TengoError,
	TengoRuntimeError,
	TengoTimeout,
	truthy,
	typeName,
	UNDEFINED,
} from "./values.ts";

/** The modules `import` can reach, built on first use and then shared. */
const MODULE_BUILDERS: ReadonlyMap<string, () => Value> = new Map([
	["text", textModule],
	["math", mathModule],
	["fmt", fmtModule],
]);

const moduleCache = new Map<string, Value>();

/** The names `import` accepts; `os` is deliberately not among them. */
export const MODULE_NAMES: readonly string[] = [...MODULE_BUILDERS.keys()];

function moduleValue(name: string): Value | undefined {
	const hit = moduleCache.get(name);
	if (hit !== undefined) return hit;
	const build = MODULE_BUILDERS.get(name);
	if (build === undefined) return undefined;
	const built = build();
	moduleCache.set(name, built);
	return built;
}

/** A variable, boxed so that a closure keeps seeing writes to it. */
interface Ref {
	value: Value;
}

/** One lexical scope. */
export class Scope {
	private readonly vars = new Map<string, Ref>();
	readonly parent: Scope | null;

	constructor(parent: Scope | null) {
		this.parent = parent;
	}

	/** Declares `name` here, as `:=` does. */
	declare(name: string, value: Value): void {
		this.vars.set(name, { value });
	}

	/** Whether `name` is declared in this scope, ignoring any enclosing one. */
	has(name: string): boolean {
		return this.vars.has(name);
	}

	/** The box for `name`, looked up outwards. */
	resolve(name: string): Ref | undefined {
		for (let s: Scope | null = this; s !== null; s = s.parent) {
			const ref = s.vars.get(name);
			if (ref !== undefined) return ref;
		}
		return undefined;
	}

	/** The value of `name` in this scope, for reading a global back out. */
	read(name: string): Value | undefined {
		return this.vars.get(name)?.value;
	}

	names(): string[] {
		return [...this.vars.keys()];
	}
}

/** What a statement does to the statement after it. */
type Flow =
	| null
	| { readonly kind: "break" }
	| { readonly kind: "continue" }
	| { readonly kind: "return"; readonly value: Value };

const BREAK: Flow = { kind: "break" };
const CONTINUE: Flow = { kind: "continue" };

/** How deep a call chain may go before it would overflow the host stack. */
const MAX_DEPTH = 2000;

export class Interpreter {
	private readonly globals: Scope;
	private readonly allowed: ReadonlySet<string>;
	private readonly timeoutMs: number;
	private deadline = Number.POSITIVE_INFINITY;
	private steps = 0;
	private depth = 0;

	constructor(globals: Scope, allowed: ReadonlySet<string>, timeoutMs: number) {
		this.globals = globals;
		this.allowed = allowed;
		this.timeoutMs = timeoutMs;
	}

	run(program: Program): void {
		this.deadline = Date.now() + this.timeoutMs;
		this.steps = 0;
		this.execBody(program.body, this.globals);
	}

	/** Checks the deadline, cheaply enough to sit in every loop. */
	private tick(): void {
		this.steps++;
		if ((this.steps & 0xff) === 0 && Date.now() > this.deadline) {
			throw new TengoTimeout(`program did not finish within ${this.timeoutMs}ms`);
		}
	}

	private fail(message: string): never {
		throw this.error(message);
	}

	/** The same failure as `fail`, to be thrown where a `throw` reads better. */
	private error(message: string): TengoError {
		return new TengoRuntimeError(message);
	}

	// --- statements -------------------------------------------------------

	private execBody(body: Stmt[], scope: Scope): Flow {
		for (const stmt of body) {
			const flow = this.exec(stmt, scope);
			if (flow !== null) return flow;
		}
		return null;
	}

	private execBlock(block: BlockStmt, scope: Scope): Flow {
		return this.execBody(block.body, new Scope(scope));
	}

	private exec(stmt: Stmt, scope: Scope): Flow {
		switch (stmt.kind) {
			case "empty":
				return null;

			case "exprStmt":
				this.eval(stmt.expr, scope);
				return null;

			case "assign":
				this.assign(stmt.op, stmt.target, stmt.value, scope);
				return null;

			case "incDec": {
				const op = stmt.op === "++" ? "+" : "-";
				const current = this.eval(stmt.target, scope);
				const next = this.binary(op, current, makeInt(1));
				this.store(stmt.target, next, scope);
				return null;
			}

			case "block":
				return this.execBody(stmt.body, new Scope(scope));

			case "if": {
				// The init statement and the condition share a scope with the
				// body, which is what makes `if a := f(); a > 0` work.
				const inner = new Scope(scope);
				if (stmt.init !== null) this.exec(stmt.init, inner);
				if (truthy(this.eval(stmt.cond, inner))) {
					return this.execBlock(stmt.then, inner);
				}
				if (stmt.otherwise !== null) return this.exec(stmt.otherwise, inner);
				return null;
			}

			case "for": {
				const header = new Scope(scope);
				if (stmt.init !== null) this.exec(stmt.init, header);
				for (;;) {
					this.tick();
					if (stmt.cond !== null && !truthy(this.eval(stmt.cond, header))) {
						return null;
					}
					const flow = this.execBlock(stmt.body, header);
					if (flow !== null) {
						if (flow.kind === "break") return null;
						if (flow.kind === "return") return flow;
					}
					if (stmt.post !== null) this.exec(stmt.post, header);
				}
			}

			case "forIn":
				return this.execForIn(stmt, scope);

			case "branch":
				return stmt.op === "break" ? BREAK : CONTINUE;

			case "return":
				return {
					kind: "return",
					value: stmt.value === null ? UNDEFINED : this.eval(stmt.value, scope),
				};

			case "export":
				// Tengo skips an export statement outright in a main module,
				// and this package only ever runs main modules.
				return null;
		}
	}

	private execForIn(stmt: Extract<Stmt, { kind: "forIn" }>, scope: Scope): Flow {
		const subject = this.eval(stmt.iterable, scope);

		const step = (key: Value, value: Value): Flow | "stop" => {
			this.tick();
			const inner = new Scope(scope);
			if (stmt.key !== "_") inner.declare(stmt.key, key);
			if (stmt.value !== "_") inner.declare(stmt.value, value);
			const flow = this.execBlock(stmt.body, inner);
			if (flow === null || flow.kind === "continue") return null;
			return flow.kind === "break" ? "stop" : flow;
		};

		const walk = (pairs: Iterable<[Value, Value]>): Flow => {
			for (const [key, value] of pairs) {
				const out = step(key, value);
				if (out === "stop") return null;
				if (out !== null) return out;
			}
			return null;
		};

		switch (subject.kind) {
			case "array":
				return walk(
					subject.value.map((item, i): [Value, Value] => [makeInt(i), item]),
				);
			case "map":
				return walk(
					[...subject.value].map(([k, v]): [Value, Value] => [makeString(k), v]),
				);
			case "bytes":
				return walk(
					[...subject.value].map((b, i): [Value, Value] => [
						makeInt(i),
						makeInt(b),
					]),
				);
			case "string": {
				// The key is a string index rather than a rune index, so that it
				// can be handed straight back to a slice; see values.ts.
				const pairs: Array<[Value, Value]> = [];
				for (let i = 0; i < subject.value.length; ) {
					const cp = subject.value.codePointAt(i) ?? 0;
					pairs.push([makeInt(i), makeChar(cp)]);
					i += cp > 0xffff ? 2 : 1;
				}
				return walk(pairs);
			}
			case "undefined":
				return null;
			default:
				this.fail(`not iterable: ${typeName(subject)}`);
		}
	}

	private assign(op: string, target: Expr, value: Expr, scope: Scope): void {
		if (op === ":=") {
			if (target.kind !== "ident") this.fail("invalid assignment target");
			if (scope.has(target.name)) {
				this.fail(`'${target.name}' redeclared in this block`);
			}
			scope.declare(target.name, this.eval(value, scope));
			return;
		}

		if (op === "=") {
			this.store(target, this.eval(value, scope), scope);
			return;
		}

		// A compound assignment reads the target, applies the operator, and
		// writes it back; the operator is the one `op` names without its `=`.
		const binop = op.slice(0, -1);
		const current = this.eval(target, scope);
		const next = this.binary(binop, current, this.eval(value, scope));
		this.store(target, next, scope);
	}

	private store(target: Expr, value: Value, scope: Scope): void {
		switch (target.kind) {
			case "ident": {
				const ref = scope.resolve(target.name);
				if (ref === undefined) {
					this.fail(`unresolved reference '${target.name}'`);
				}
				ref.value = value;
				return;
			}
			case "index":
				this.indexSet(
					this.eval(target.target, scope),
					this.eval(target.index, scope),
					value,
				);
				return;
			case "selector":
				this.indexSet(
					this.eval(target.target, scope),
					makeString(target.name),
					value,
				);
				return;
			default:
				this.fail("invalid assignment target");
		}
	}

	private indexSet(container: Value, index: Value, value: Value): void {
		switch (container.kind) {
			case "array": {
				if (container.immutable) this.fail("array is immutable");
				if (index.kind !== "int") this.fail("invalid index type");
				if (index.value < 0 || index.value >= container.value.length) {
					this.fail("index out of bounds");
				}
				container.value[index.value] = value;
				return;
			}
			case "map": {
				if (container.immutable) this.fail("map is immutable");
				if (index.kind !== "string") this.fail("invalid index type");
				container.value.set(index.value, value);
				return;
			}
			case "bytes": {
				if (index.kind !== "int") this.fail("invalid index type");
				if (index.value < 0 || index.value >= container.value.length) {
					this.fail("index out of bounds");
				}
				if (value.kind !== "int") this.fail("invalid value type");
				container.value[index.value] = value.value & 0xff;
				return;
			}
			default:
				this.fail(`not index-assignable: ${typeName(container)}`);
		}
	}

	// --- expressions ------------------------------------------------------

	private eval(expr: Expr, scope: Scope): Value {
		switch (expr.kind) {
			case "int":
				return makeInt(expr.value);
			case "float":
				return makeFloat(expr.value);
			case "string":
				return makeString(expr.value);
			case "char":
				return makeChar(expr.value);
			case "bool":
				return makeBool(expr.value);
			case "undefinedLit":
				return UNDEFINED;

			case "ident": {
				const ref = scope.resolve(expr.name);
				if (ref !== undefined) return ref.value;
				const builtin = BUILTINS.get(expr.name);
				if (builtin !== undefined) return builtin;
				throw this.error(`unresolved reference '${expr.name}'`);
			}

			case "arrayLit":
				return makeArray(expr.elements.map((e) => this.eval(e, scope)));

			case "mapLit": {
				const out = new Map<string, Value>();
				for (const entry of expr.entries) {
					out.set(entry.key, this.eval(entry.value, scope));
				}
				return makeMap(out);
			}

			case "funcLit":
				return this.closure(expr, scope);

			case "unary":
				return this.unary(expr.op, this.eval(expr.operand, scope));

			case "binary": {
				// The logical operators short-circuit and return the operand
				// itself, not a bool, which is what Tengo's jumps amount to.
				if (expr.op === "&&") {
					const left = this.eval(expr.left, scope);
					return truthy(left) ? this.eval(expr.right, scope) : left;
				}
				if (expr.op === "||") {
					const left = this.eval(expr.left, scope);
					return truthy(left) ? left : this.eval(expr.right, scope);
				}
				return this.binary(
					expr.op,
					this.eval(expr.left, scope),
					this.eval(expr.right, scope),
				);
			}

			case "cond":
				return truthy(this.eval(expr.test, scope))
					? this.eval(expr.then, scope)
					: this.eval(expr.otherwise, scope);

			case "index":
				return this.indexGet(
					this.eval(expr.target, scope),
					this.eval(expr.index, scope),
				);

			case "selector":
				return this.indexGet(this.eval(expr.target, scope), makeString(expr.name));

			case "slice":
				return this.slice(expr, scope);

			case "call":
				return this.call(expr, scope);

			case "import": {
				if (!this.allowed.has(expr.module)) {
					this.fail(`module '${expr.module}' not found`);
				}
				const mod = moduleValue(expr.module);
				if (mod === undefined) this.fail(`module '${expr.module}' not found`);
				return mod;
			}

			case "errorExpr":
				return makeError(this.eval(expr.value, scope));

			case "immutableExpr":
				return freezeShallow(this.eval(expr.value, scope));
		}
	}

	/** Builds a function value for a literal, closing over `defining`. */
	private closure(
		literal: Extract<Expr, { kind: "funcLit" }>,
		defining: Scope,
	): Value {
		const { params, variadic, body } = literal;
		const fixed = variadic ? params.length - 1 : params.length;

		const call = (args: Value[]): Value => {
			this.tick();
			if (variadic ? args.length < fixed : args.length !== params.length) {
				this.fail(
					`wrong number of arguments: want=${variadic ? `${fixed}+` : params.length}, got=${args.length}`,
				);
			}
			if (++this.depth > MAX_DEPTH) {
				this.depth--;
				this.fail("stack overflow");
			}
			try {
				const inner = new Scope(defining);
				for (let i = 0; i < fixed; i++) {
					inner.declare(params[i]!, args[i] ?? UNDEFINED);
				}
				if (variadic) {
					inner.declare(params[fixed]!, makeArray(args.slice(fixed)));
				}
				const flow = this.execBody(body.body, inner);
				return flow !== null && flow.kind === "return" ? flow.value : UNDEFINED;
			} finally {
				this.depth--;
			}
		};

		return { kind: "func", name: "", literal: true, call };
	}

	private call(expr: Extract<Expr, { kind: "call" }>, scope: Scope): Value {
		const callee = this.eval(expr.callee, scope);
		const args: Value[] = [];
		for (let i = 0; i < expr.args.length; i++) {
			const value = this.eval(expr.args[i]!, scope);
			const last = i === expr.args.length - 1;
			if (last && expr.spread) {
				if (value.kind !== "array") {
					this.fail(`not an array: ${typeName(value)}`);
				}
				args.push(...value.value);
			} else {
				args.push(value);
			}
		}

		if (callee.kind !== "func") {
			this.fail(`not callable: ${typeName(callee)}`);
		}
		this.tick();
		return callee.call(args);
	}

	private slice(expr: Extract<Expr, { kind: "slice" }>, scope: Scope): Value {
		const target = this.eval(expr.target, scope);
		if (
			target.kind !== "array" &&
			target.kind !== "string" &&
			target.kind !== "bytes"
		) {
			this.fail(`cannot slice: ${typeName(target)}`);
		}

		const bound = (at: Expr | null, fallback: number): number => {
			if (at === null) return fallback;
			const v = this.eval(at, scope);
			if (v.kind !== "int") {
				this.fail(`invalid slice index type: ${typeName(v)}`);
			}
			return v.value;
		};

		const length = target.value.length;
		let low = bound(expr.low, 0);
		let high = bound(expr.high, length);
		if (low > high) this.fail(`invalid slice index: ${low} > ${high}`);
		low = Math.min(Math.max(low, 0), length);
		high = Math.min(Math.max(high, 0), length);

		// A slice of an immutable array is mutable, as in Tengo.
		if (target.kind === "array") return makeArray(target.value.slice(low, high));
		if (target.kind === "string") return makeString(target.value.slice(low, high));
		return makeBytes(target.value.slice(low, high));
	}

	private indexGet(container: Value, index: Value): Value {
		switch (container.kind) {
			case "array": {
				if (index.kind !== "int") this.fail("invalid index type");
				return container.value[index.value] ?? UNDEFINED;
			}
			case "map": {
				if (index.kind !== "string") this.fail("invalid index type");
				return container.value.get(index.value) ?? UNDEFINED;
			}
			case "string": {
				if (index.kind !== "int") this.fail("invalid index type");
				const i = index.value;
				if (i < 0 || i >= container.value.length) return UNDEFINED;
				return makeChar(container.value.codePointAt(i) ?? 0);
			}
			case "bytes": {
				if (index.kind !== "int") this.fail("invalid index type");
				const b = container.value[index.value];
				return b === undefined ? UNDEFINED : makeInt(b);
			}
			case "error": {
				// An error's one member is `value`, the thing it wraps.
				if (index.kind === "string" && index.value === "value") {
					return container.value;
				}
				throw this.error("invalid index on error");
			}
			case "undefined":
				// Reading through undefined stays undefined, so `m.x.y.z` on a
				// map without `x` is undefined rather than an error.
				return UNDEFINED;
			default:
				this.fail(`not indexable: ${typeName(container)}`);
		}
	}

	// --- operators --------------------------------------------------------

	private unary(op: string, operand: Value): Value {
		switch (op) {
			case "!":
				return makeBool(!truthy(operand));
			case "+":
				if (operand.kind === "int" || operand.kind === "float") return operand;
				break;
			case "-":
				if (operand.kind === "int") return makeInt(-operand.value);
				if (operand.kind === "float") return makeFloat(-operand.value);
				break;
			case "^":
				if (operand.kind === "int") {
					return makeInt(Number(BigInt.asIntN(64, ~BigInt(operand.value))));
				}
				break;
		}
		this.fail(`invalid operation: ${op}${typeName(operand)}`);
	}

	/**
	 * Applies a binary operator.
	 *
	 * The type pairings come from Tengo's `BinaryOp` methods: int and float mix
	 * to a float, int and char mix to a char, `%` and the bitwise operators are
	 * int-only, and a string on the left absorbs anything on the right.
	 */
	private binary(op: string, left: Value, right: Value): Value {
		if (op === "==") return makeBool(equals(left, right));
		if (op === "!=") return makeBool(!equals(left, right));

		if (left.kind === "int" && right.kind === "int") {
			return this.intOp(op, left.value, right.value);
		}

		if (
			(left.kind === "float" || left.kind === "int") &&
			(right.kind === "float" || right.kind === "int")
		) {
			return this.floatOp(op, left.value, right.value);
		}

		if (
			(left.kind === "char" || left.kind === "int") &&
			(right.kind === "char" || right.kind === "int")
		) {
			// One of the two is a char here; the result of + and - is a char.
			const a = left.value;
			const b = right.value;
			switch (op) {
				case "+":
					return makeChar(a + b);
				case "-":
					return makeChar(a - b);
				case "<":
					return makeBool(a < b);
				case ">":
					return makeBool(a > b);
				case "<=":
					return makeBool(a <= b);
				case ">=":
					return makeBool(a >= b);
			}
		}

		if (left.kind === "string") {
			if (op === "+") {
				const tail = right.kind === "string" ? right.value : display(right);
				return makeString(left.value + tail);
			}
			if (right.kind === "string") {
				switch (op) {
					case "<":
						return makeBool(left.value < right.value);
					case ">":
						return makeBool(left.value > right.value);
					case "<=":
						return makeBool(left.value <= right.value);
					case ">=":
						return makeBool(left.value >= right.value);
				}
			}
		}

		if (left.kind === "array" && right.kind === "array" && op === "+") {
			return makeArray([...left.value, ...right.value]);
		}

		if (left.kind === "time") {
			if (right.kind === "time") {
				// Go reports the difference in nanoseconds.
				switch (op) {
					case "-":
						return makeInt((left.value - right.value) * 1e6);
					case "<":
						return makeBool(left.value < right.value);
					case ">":
						return makeBool(left.value > right.value);
					case "<=":
						return makeBool(left.value <= right.value);
					case ">=":
						return makeBool(left.value >= right.value);
				}
			}
			if (right.kind === "int") {
				if (op === "+")
					return { kind: "time", value: left.value + right.value / 1e6 };
				if (op === "-")
					return { kind: "time", value: left.value - right.value / 1e6 };
			}
		}

		this.fail(`invalid operation: ${typeName(left)} ${op} ${typeName(right)}`);
	}

	private intOp(op: string, a: number, b: number): Value {
		switch (op) {
			case "+":
				return makeInt(a + b);
			case "-":
				return makeInt(a - b);
			case "*":
				return makeInt(a * b);
			case "/":
				if (b === 0) this.fail("runtime error: integer divide by zero");
				// Go truncates towards zero rather than flooring.
				return makeInt(Math.trunc(a / b));
			case "%":
				if (b === 0) this.fail("runtime error: integer divide by zero");
				return makeInt(a % b);
			case "&":
				return makeInt(wrap((x, y) => x & y, a, b));
			case "|":
				return makeInt(wrap((x, y) => x | y, a, b));
			case "^":
				return makeInt(wrap((x, y) => x ^ y, a, b));
			case "&^":
				return makeInt(wrap((x, y) => x & ~y, a, b));
			case "<<":
				return makeInt(shift(a, b, true));
			case ">>":
				return makeInt(shift(a, b, false));
			case "<":
				return makeBool(a < b);
			case ">":
				return makeBool(a > b);
			case "<=":
				return makeBool(a <= b);
			case ">=":
				return makeBool(a >= b);
			default:
				this.fail(`invalid operation: int ${op} int`);
		}
	}

	private floatOp(op: string, a: number, b: number): Value {
		switch (op) {
			case "+":
				return makeFloat(a + b);
			case "-":
				return makeFloat(a - b);
			case "*":
				return makeFloat(a * b);
			case "/":
				return makeFloat(a / b);
			case "<":
				return makeBool(a < b);
			case ">":
				return makeBool(a > b);
			case "<=":
				return makeBool(a <= b);
			case ">=":
				return makeBool(a >= b);
			default:
				// Tengo has no float `%`; `math.mod` is the way to ask for it.
				this.fail(`invalid operation: float ${op} float`);
		}
	}
}

/** Applies a bitwise operator at 64 bits, as Go's int does. */
function wrap(fn: (x: bigint, y: bigint) => bigint, a: number, b: number): number {
	return Number(BigInt.asIntN(64, fn(BigInt(a), BigInt(b))));
}

/**
 * Shifts at 64 bits.
 *
 * Go reads the count as an unsigned 64-bit value, so a negative count is a
 * count far past the word size: everything is shifted out, leaving 0 for `<<`
 * and the sign for `>>`.
 */
function shift(a: number, count: number, left: boolean): number {
	if (count < 0 || count >= 64) return left ? 0 : a < 0 ? -1 : 0;
	const bits = BigInt.asIntN(64, BigInt(a));
	const by = BigInt(count);
	return Number(BigInt.asIntN(64, left ? bits << by : bits >> by));
}
