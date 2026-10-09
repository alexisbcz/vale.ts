/**
 * The expression language a conditional section and `--filter` are written in.
 *
 * Go uses `expr-lang/expr`. This is a small evaluator for the subset Vale
 * actually exposes: member access, comparison, the boolean operators, `in`,
 * `matches`, `contains`, `startsWith`/`endsWith`, `??`, and the handful of
 * builtins a filter needs. Anything outside that subset is a parse error
 * rather than a silent wrong answer.
 *
 * One deliberate difference from a general expression language: a member that
 * is missing reads as false in a boolean position. `.Meta.draft` on a file
 * with no `draft` key is nothing at all, and `not .Meta.draft` has to be true
 * rather than an error -- which is the patch Vale applies to `expr` for the
 * same reason.
 */

export type Value = unknown;

/** What an expression can see. */
export type Environment = Record<string, Value>;

export class ExprError extends Error {
	/**
	 * The token the error is about, when it is about one.
	 *
	 * Kept so the error can be re-pointed: a condition is compiled inside
	 * `any(Files, {...})`, and running out of tokens inside the braces is, to
	 * Go, the closing brace arriving early.
	 */
	readonly token: Token | null;
	/** Whether the wording is `unexpected token <token>`. */
	readonly aboutToken: boolean;

	constructor(message: string, token: Token | null = null, aboutToken = false) {
		super(message);
		this.name = "ExprError";
		this.token = token;
		this.aboutToken = aboutToken;
	}
}

/** The text Go compiles around an expression, for reporting errors in it. */
export interface ExprFrame {
	prefix: string;
	suffix: string;
}

/** How an expression is compiled. */
export interface CompileOptions {
	/**
	 * Require the expression to be usable as a condition.
	 *
	 * Go passes `expr.AsBool()`, which refuses an expression whose static type
	 * is something other than a boolean, so `[*.md if "text"]` is reported when
	 * the configuration loads rather than read as always true. Only a type that
	 * is *known* is refused; a member access reads a value of unknown type and
	 * is judged by its truthiness, which is the whole point of `.Meta.draft`.
	 */
	asBool?: boolean;
	/**
	 * What Go compiles the expression inside of.
	 *
	 * A section's `if` becomes the body of `any(Files, {...})`, and `expr`
	 * reports a position in *that* text. This port parses the condition on its
	 * own -- the wrapper adds nothing to evaluate, since there is one file --
	 * so the frame is carried here and applied when an error is worded.
	 */
	frame?: ExprFrame;
}

/**
 * How `expr` names a token in an error.
 *
 * Its lexer has five kinds, and an error quotes the offending token as
 * `Kind("text")` -- `Bracket("}")`, `Operator("==")`. The wording is what a
 * person reading Vale's documentation sees, so it is reproduced.
 */
function tokenText(tok: Token): string {
	const kind =
		tok.type === "punct" && BRACKETS.has(tok.value)
			? "Bracket"
			: TOKEN_KINDS[tok.type];
	if (tok.value === "") return kind;
	return `${kind}(${JSON.stringify(tok.value)})`;
}

/** This lexer's token types, named the way `expr`'s lexer names them. */
const TOKEN_KINDS: Record<TokenType, string> = {
	number: "Number",
	string: "String",
	identifier: "Identifier",
	operator: "Operator",
	// `expr` separates the brackets from the other punctuation, so this is
	// the fallback for a comma or a colon; `tokenText` picks out a bracket.
	punct: "Operator",
	eof: "EOF",
};

/** The punctuation `expr` calls a bracket rather than an operator. */
const BRACKETS = new Set(["(", ")", "[", "]", "{", "}"]);

function unexpected(tok: Token): ExprError {
	return new ExprError(`unexpected token ${tokenText(tok)}`, tok, true);
}

/**
 * Adds the position and the excerpt `expr` puts on a compile error.
 *
 * ```text
 * unexpected token Bracket("}") (1:31)
 *  | any(Files, {.Meta.published ==})
 *  | ..............................^
 * ```
 *
 * The excerpt is dropped by `--output=line`, which keeps the first line of a
 * message, and kept by `--output=JSON`, which is where it is visible.
 */
function locate(err: ExprError, source: string, frame?: ExprFrame): ExprError {
	const tok = err.token;
	if (tok === null) return err;

	const prefix = frame?.prefix ?? "";
	const suffix = frame?.suffix ?? "";
	const full = prefix + source + suffix;

	let at = prefix.length + tok.at;
	let message = err.message;

	// Running out of tokens inside the frame is not the end of the text: it is
	// the frame's own next token, which is what Go reports.
	if (tok.type === "eof" && suffix !== "" && err.aboutToken) {
		const next = lex(suffix)[0];
		if (next !== undefined) {
			at = prefix.length + source.length + next.at;
			message = unexpected(next).message;
		}
	}

	const start = full.lastIndexOf("\n", at - 1) + 1;
	const end = full.indexOf("\n", at);
	const text = full.slice(start, end < 0 ? full.length : end);
	const line = countLines(full, at);
	const column = at - start + 1;
	const caret = `${".".repeat(column - 1)}^`;

	return new ExprError(
		`${message} (${line}:${column})\n | ${text}\n | ${caret}`,
		tok,
		err.aboutToken,
	);
}

/** The 1-based line `at` falls on. */
function countLines(src: string, at: number): number {
	let line = 1;
	for (let i = 0; i < at && i < src.length; i++) {
		if (src[i] === "\n") line++;
	}
	return line;
}

/** A compiled expression. */
export class Expression {
	readonly source: string;
	private readonly node: Node;

	constructor(source: string, options: CompileOptions = {}) {
		this.source = source;
		try {
			const parser = new Parser(source);
			this.node = parser.parseExpression(0);
			parser.expectEnd();

			if (options.asBool === true) {
				const kind = staticKind(this.node);
				if (kind !== "bool" && kind !== "unknown") {
					throw new ExprError(`expected a condition, found a ${kind}`);
				}
			}
		} catch (err) {
			if (err instanceof ExprError) throw locate(err, source, options.frame);
			throw err;
		}
	}

	/**
	 * Evaluates the expression against `env`.
	 *
	 * `item` is what a leading dot addresses -- the element under
	 * consideration, which is `#` inside a closure. A caller evaluating an
	 * expression that was *written* as a predicate, as a section's `if` is,
	 * passes the item itself.
	 */
	run(env: Environment, item?: Value): Value {
		return evaluate(this.node, env, item);
	}

	/** Evaluates it and reads the result as a boolean. */
	runBool(env: Environment, item?: Value): boolean {
		return truthy(this.run(env, item));
	}
}

/** Compiles an expression, throwing `ExprError` if it cannot be read. */
export function compileExpr(
	source: string,
	options: CompileOptions = {},
): Expression {
	return new Expression(source, options);
}

/** What an expression's value is known to be, or "unknown". */
type StaticKind = "bool" | "number" | "string" | "array" | "map" | "unknown";

/** The builtins whose return type is fixed. */
const RETURN_KINDS: Record<string, StaticKind> = {
	any: "bool",
	all: "bool",
	none: "bool",
	one: "bool",
	filter: "array",
	map: "array",
	split: "array",
	len: "number",
	int: "number",
	float: "number",
	abs: "number",
	max: "number",
	min: "number",
	lower: "string",
	upper: "string",
	trim: "string",
	join: "string",
	string: "string",
	hasPrefix: "bool",
	hasSuffix: "bool",
};

/** The operators whose result type is fixed. */
const OPERATOR_KINDS: Record<string, StaticKind> = {
	"==": "bool",
	"!=": "bool",
	"<": "bool",
	">": "bool",
	"<=": "bool",
	">=": "bool",
	and: "bool",
	"&&": "bool",
	or: "bool",
	"||": "bool",
	in: "bool",
	matches: "bool",
	contains: "bool",
	startsWith: "bool",
	endsWith: "bool",
	"-": "number",
	"*": "number",
	"/": "number",
	"%": "number",
	"**": "number",
};

function staticKind(node: Node): StaticKind {
	switch (node.kind) {
		case "literal": {
			const v = node.value;
			if (typeof v === "boolean") return "bool";
			if (typeof v === "number") return "number";
			if (typeof v === "string") return "string";
			return "unknown";
		}
		case "array":
			return "array";
		case "map":
			return "map";
		case "unary":
			return node.op === "!" || node.op === "not" ? "bool" : "number";
		case "binary":
			// `??` and `+` both depend on their operands, so they stay unknown.
			return OPERATOR_KINDS[node.op] ?? "unknown";
		case "call":
			return RETURN_KINDS[node.name] ?? "unknown";
		case "conditional": {
			const then = staticKind(node.then);
			return then === staticKind(node.otherwise) ? then : "unknown";
		}
		default:
			return "unknown";
	}
}

/**
 * Whether a value counts as true.
 *
 * `undefined` and `null` are false, which is what makes a missing member
 * usable as a condition.
 */
export function truthy(v: Value): boolean {
	if (v === undefined || v === null) return false;
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") return v !== "";
	if (Array.isArray(v)) return v.length > 0;
	return true;
}

// --- syntax tree ----------------------------------------------------------

type Node =
	| { kind: "literal"; value: Value }
	| { kind: "identifier"; name: string }
	| { kind: "pointer" }
	| { kind: "member"; target: Node; name: string; optional: boolean }
	| { kind: "index"; target: Node; index: Node }
	| { kind: "unary"; op: string; operand: Node }
	| { kind: "binary"; op: string; left: Node; right: Node }
	| { kind: "conditional"; test: Node; then: Node; otherwise: Node }
	| { kind: "call"; name: string; args: Node[] }
	| { kind: "closure"; body: Node }
	| { kind: "array"; items: Node[] }
	| { kind: "map"; entries: Array<[string, Node]> };

// --- lexer ----------------------------------------------------------------

type TokenType = "number" | "string" | "identifier" | "operator" | "punct" | "eof";

interface Token {
	type: TokenType;
	value: string;
	at: number;
}

const OPERATORS = [
	"??",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"**",
	"?.",
	"+",
	"-",
	"*",
	"/",
	"%",
	"<",
	">",
	"!",
	".",
];

const KEYWORD_OPERATORS = new Set([
	"and",
	"or",
	"not",
	"in",
	"matches",
	"contains",
	"startsWith",
	"endsWith",
]);

function lex(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;

	while (i < src.length) {
		const c = src[i]!;

		if (/\s/.test(c)) {
			i++;
			continue;
		}

		if (c === '"' || c === "'") {
			const [text, next] = readString(src, i);
			out.push({ type: "string", value: text, at: i });
			i = next;
			continue;
		}

		if (/[0-9]/.test(c)) {
			let j = i;
			while (j < src.length && /[0-9._]/.test(src[j]!)) j++;
			out.push({ type: "number", value: src.slice(i, j), at: i });
			i = j;
			continue;
		}

		if (/[A-Za-z_$#]/.test(c)) {
			let j = i;
			while (j < src.length && /[A-Za-z0-9_$#]/.test(src[j]!)) j++;
			out.push({ type: "identifier", value: src.slice(i, j), at: i });
			i = j;
			continue;
		}

		if ("()[]{},:".includes(c)) {
			out.push({ type: "punct", value: c, at: i });
			i++;
			continue;
		}

		const op = OPERATORS.find((o) => src.startsWith(o, i));
		if (op !== undefined) {
			out.push({ type: "operator", value: op, at: i });
			i += op.length;
			continue;
		}

		throw new ExprError(`unexpected character '${c}' at ${i}`);
	}

	out.push({ type: "eof", value: "", at: src.length });
	return out;
}

function readString(src: string, start: number): [string, number] {
	const quote = src[start]!;
	let out = "";
	let i = start + 1;
	while (i < src.length) {
		const c = src[i]!;
		if (c === "\\") {
			const next = src[i + 1];
			if (next === undefined) break;
			switch (next) {
				case "n":
					out += "\n";
					break;
				case "t":
					out += "\t";
					break;
				case "r":
					out += "\r";
					break;
				default:
					out += next;
					break;
			}
			i += 2;
			continue;
		}
		if (c === quote) return [out, i + 1];
		out += c;
		i++;
	}
	throw new ExprError(`unterminated string at ${start}`);
}

// --- parser ---------------------------------------------------------------

/** Binding powers, loosest first. */
const BINARY_PRECEDENCE: Record<string, number> = {
	"??": 1,
	or: 2,
	"||": 2,
	and: 3,
	"&&": 3,
	"==": 4,
	"!=": 4,
	"<": 5,
	">": 5,
	"<=": 5,
	">=": 5,
	in: 5,
	matches: 5,
	contains: 5,
	startsWith: 5,
	endsWith: 5,
	"+": 6,
	"-": 6,
	"*": 7,
	"/": 7,
	"%": 7,
	"**": 8,
};

/** The operators that group to the right. */
const RIGHT_ASSOCIATIVE = new Set(["**"]);

/** Whether a token is the punctuation or operator spelled `value`. */
function isSyntax(tok: Token, value: string): boolean {
	return (tok.type === "punct" || tok.type === "operator") && tok.value === value;
}

class Parser {
	private readonly tokens: Token[];
	private pos = 0;

	constructor(src: string) {
		this.tokens = lex(src);
	}

	expectEnd(): void {
		if (this.peek().type !== "eof") {
			throw unexpected(this.peek());
		}
	}

	private peek(ahead = 0): Token {
		return this.tokens[this.pos + ahead] ?? { type: "eof", value: "", at: 0 };
	}

	private next(): Token {
		return this.tokens[this.pos++] ?? { type: "eof", value: "", at: 0 };
	}

	/**
	 * Consumes a punctuation or operator token with this spelling.
	 *
	 * The token's *type* is part of the test: a string whose text happens to
	 * be `-` or `(` is a value, not syntax, and matching it on spelling alone
	 * made `join(["a"], "-")` parse its last argument as a unary minus.
	 */
	private eat(value: string): boolean {
		const tok = this.peek();
		if (isSyntax(tok, value)) {
			this.pos++;
			return true;
		}
		return false;
	}

	private expect(value: string): void {
		if (!this.eat(value)) {
			throw new ExprError(`expected '${value}', found '${this.peek().value}'`);
		}
	}

	parseExpression(minPrecedence: number): Node {
		let left = this.parseUnary();

		for (;;) {
			const tok = this.peek();
			const op = tok.value;
			const isOperator =
				tok.type === "operator" ||
				(tok.type === "identifier" && KEYWORD_OPERATORS.has(op));
			if (!isOperator) break;

			if (op === "?" || op === ":") break;

			const precedence = BINARY_PRECEDENCE[op];
			if (precedence === undefined || precedence < minPrecedence) break;

			this.pos++;
			// `**` is the one right-associative operator, so `2 ** 3 ** 2` is
			// `2 ** (3 ** 2)`, as it is in `expr-lang`.
			const right = this.parseExpression(
				RIGHT_ASSOCIATIVE.has(op) ? precedence : precedence + 1,
			);
			left = { kind: "binary", op, left, right };
		}

		return left;
	}

	private parseUnary(): Node {
		const tok = this.peek();
		if (
			tok.type === "operator" &&
			(tok.value === "!" || tok.value === "-" || tok.value === "+")
		) {
			this.pos++;
			return { kind: "unary", op: tok.value, operand: this.parseUnary() };
		}
		if (tok.type === "identifier" && tok.value === "not") {
			this.pos++;
			return { kind: "unary", op: "not", operand: this.parseUnary() };
		}
		return this.parsePostfix(this.parsePrimary());
	}

	private parsePostfix(target: Node): Node {
		let node = target;
		for (;;) {
			if (isSyntax(this.peek(), ".") || isSyntax(this.peek(), "?.")) {
				const optional = this.next().value === "?.";
				const name = this.next();
				if (name.type !== "identifier") {
					throw new ExprError(`expected a field name, found '${name.value}'`);
				}
				node = { kind: "member", target: node, name: name.value, optional };
				continue;
			}
			if (isSyntax(this.peek(), "[")) {
				this.pos++;
				const index = this.parseExpression(0);
				this.expect("]");
				node = { kind: "index", target: node, index };
				continue;
			}
			return node;
		}
	}

	private parsePrimary(): Node {
		const tok = this.next();

		if (tok.type === "number") {
			return { kind: "literal", value: Number(tok.value.replaceAll("_", "")) };
		}
		if (tok.type === "string") {
			return { kind: "literal", value: tok.value };
		}

		if (isSyntax(tok, "(")) {
			const inner = this.parseExpression(0);
			this.expect(")");
			return inner;
		}

		if (isSyntax(tok, "[")) {
			const items: Node[] = [];
			if (!isSyntax(this.peek(), "]")) {
				do {
					items.push(this.parseExpression(0));
				} while (this.eat(","));
			}
			this.expect("]");
			return { kind: "array", items };
		}

		if (isSyntax(tok, "{")) {
			// A brace here is a closure body -- `any(Files, {.Ext == ".md"})` --
			// unless it holds `key: value` pairs, which is a map literal. The
			// closure form is the one Vale generates, so it is tried first.
			const entries: Array<[string, Node]> = [];
			const keyed =
				(this.peek().type === "identifier" || this.peek().type === "string") &&
				isSyntax(this.peek(1), ":");
			if (keyed) {
				do {
					const key = this.next();
					this.expect(":");
					entries.push([key.value, this.parseExpression(0)]);
				} while (this.eat(","));
				this.expect("}");
				return { kind: "map", entries };
			}
			const body = this.parseExpression(0);
			this.expect("}");
			return { kind: "closure", body };
		}

		if (isSyntax(tok, ".")) {
			// A leading dot addresses the item under consideration, which is
			// how both a section's condition and `--filter` are written.
			const name = this.next();
			if (name.type !== "identifier") {
				throw new ExprError(`expected a field name, found '${name.value}'`);
			}
			return {
				kind: "member",
				target: { kind: "pointer" },
				name: name.value,
				optional: true,
			};
		}

		if (tok.type === "identifier") {
			if (tok.value === "true") return { kind: "literal", value: true };
			if (tok.value === "false") return { kind: "literal", value: false };
			if (tok.value === "nil" || tok.value === "null") {
				return { kind: "literal", value: null };
			}
			if (tok.value === "#") return { kind: "pointer" };

			if (isSyntax(this.peek(), "(")) {
				this.pos++;
				const args: Node[] = [];
				if (!isSyntax(this.peek(), ")")) {
					do {
						args.push(this.parseExpression(0));
					} while (this.eat(","));
				}
				this.expect(")");
				return { kind: "call", name: tok.value, args };
			}

			return { kind: "identifier", name: tok.value };
		}

		throw unexpected(tok);
	}
}

// --- evaluation -----------------------------------------------------------

function evaluate(node: Node, env: Environment, pointer: Value): Value {
	switch (node.kind) {
		case "literal":
			return node.value;

		case "pointer":
			return pointer;

		case "identifier": {
			if (Object.hasOwn(env, node.name)) return env[node.name];
			// An unknown name is nothing, which the boolean operators read as
			// false rather than refusing.
			return undefined;
		}

		case "member": {
			const target = evaluate(node.target, env, pointer);
			if (target === undefined || target === null) return undefined;
			if (typeof target !== "object") return undefined;
			return (target as Record<string, Value>)[node.name];
		}

		case "index": {
			const target = evaluate(node.target, env, pointer);
			const index = evaluate(node.index, env, pointer);
			if (target === undefined || target === null) return undefined;
			if (Array.isArray(target) && typeof index === "number") {
				return target[index < 0 ? target.length + index : index];
			}
			if (typeof target === "string" && typeof index === "number") {
				return target[index];
			}
			if (typeof target === "object" && typeof index === "string") {
				return (target as Record<string, Value>)[index];
			}
			return undefined;
		}

		case "unary": {
			if (node.op === "!" || node.op === "not") {
				return !truthy(evaluate(node.operand, env, pointer));
			}
			const v = Number(evaluate(node.operand, env, pointer));
			return node.op === "-" ? -v : v;
		}

		case "binary":
			return binary(node.op, node.left, node.right, env, pointer);

		case "conditional":
			return truthy(evaluate(node.test, env, pointer))
				? evaluate(node.then, env, pointer)
				: evaluate(node.otherwise, env, pointer);

		case "array":
			return node.items.map((i) => evaluate(i, env, pointer));

		case "map": {
			const out: Record<string, Value> = {};
			for (const [k, v] of node.entries) out[k] = evaluate(v, env, pointer);
			return out;
		}

		case "closure":
			// Reached only when something other than a builtin evaluates it,
			// which means the expression used a closure where a value belongs.
			throw new ExprError("a closure is not a value");

		case "call":
			return call(node, env, pointer);
	}
}

function binary(
	op: string,
	leftNode: Node,
	rightNode: Node,
	env: Environment,
	pointer: Value,
): Value {
	// The short-circuiting operators have to decide before evaluating the
	// right-hand side, which is what makes `.Meta.x and .Meta.x.y` safe.
	if (op === "and" || op === "&&") {
		return (
			truthy(evaluate(leftNode, env, pointer)) &&
			truthy(evaluate(rightNode, env, pointer))
		);
	}
	if (op === "or" || op === "||") {
		return (
			truthy(evaluate(leftNode, env, pointer)) ||
			truthy(evaluate(rightNode, env, pointer))
		);
	}
	if (op === "??") {
		const left = evaluate(leftNode, env, pointer);
		return left === undefined || left === null
			? evaluate(rightNode, env, pointer)
			: left;
	}

	const left = evaluate(leftNode, env, pointer);
	const right = evaluate(rightNode, env, pointer);

	switch (op) {
		case "==":
			return equals(left, right);
		case "!=":
			return !equals(left, right);
		case "<":
			return compare(left, right) < 0;
		case ">":
			return compare(left, right) > 0;
		case "<=":
			return compare(left, right) <= 0;
		case ">=":
			return compare(left, right) >= 0;
		case "+":
			if (typeof left === "string" || typeof right === "string") {
				return `${asString(left)}${asString(right)}`;
			}
			return Number(left) + Number(right);
		case "-":
			return Number(left) - Number(right);
		case "*":
			return Number(left) * Number(right);
		case "/":
			return Number(left) / Number(right);
		case "%":
			return Number(left) % Number(right);
		case "**":
			return Number(left) ** Number(right);
		case "in":
			if (Array.isArray(right)) return right.some((v) => equals(v, left));
			if (typeof right === "string") return right.includes(asString(left));
			if (right !== null && typeof right === "object") {
				return Object.hasOwn(right as object, asString(left));
			}
			return false;
		case "contains":
			if (Array.isArray(left)) return left.some((v) => equals(v, right));
			return asString(left).includes(asString(right));
		case "startsWith":
			return asString(left).startsWith(asString(right));
		case "endsWith":
			return asString(left).endsWith(asString(right));
		case "matches":
			try {
				return new RegExp(asString(right), "u").test(asString(left));
			} catch {
				throw new ExprError(`'${asString(right)}' is not a valid pattern`);
			}
		default:
			throw new ExprError(`unknown operator '${op}'`);
	}
}

function call(
	node: Extract<Node, { kind: "call" }>,
	env: Environment,
	pointer: Value,
): Value {
	const { name, args } = node;

	// The predicate builtins take a closure, so their second argument is not
	// evaluated up front.
	if (name === "any" || name === "all" || name === "none" || name === "one") {
		const list = asArray(evaluate(args[0]!, env, pointer));
		const body = args[1];
		if (body === undefined || body.kind !== "closure") {
			throw new ExprError(`${name}() needs a predicate`);
		}
		const hits = list.filter((item) => truthy(evaluate(body.body, env, item)));
		switch (name) {
			case "any":
				return hits.length > 0;
			case "all":
				return hits.length === list.length;
			case "none":
				return hits.length === 0;
			default:
				return hits.length === 1;
		}
	}
	if (name === "filter" || name === "map") {
		const list = asArray(evaluate(args[0]!, env, pointer));
		const body = args[1];
		if (body === undefined || body.kind !== "closure") {
			throw new ExprError(`${name}() needs a predicate`);
		}
		if (name === "filter") {
			return list.filter((item) => truthy(evaluate(body.body, env, item)));
		}
		return list.map((item) => evaluate(body.body, env, item));
	}

	const values = args.map((a) => evaluate(a, env, pointer));

	switch (name) {
		case "len": {
			const v = values[0];
			if (typeof v === "string") return [...v].length;
			if (Array.isArray(v)) return v.length;
			if (v !== null && typeof v === "object") return Object.keys(v).length;
			return 0;
		}
		case "lower":
			return asString(values[0]).toLowerCase();
		case "upper":
			return asString(values[0]).toUpperCase();
		case "trim":
			return values.length > 1
				? trimChars(asString(values[0]), asString(values[1]))
				: asString(values[0]).trim();
		case "split":
			return asString(values[0]).split(asString(values[1]));
		case "join":
			return asArray(values[0])
				.map(asString)
				.join(values.length > 1 ? asString(values[1]) : "");
		case "int":
			return Math.trunc(Number(values[0]));
		case "float":
			return Number(values[0]);
		case "string":
			return asString(values[0]);
		case "abs":
			return Math.abs(Number(values[0]));
		case "max":
			return Math.max(...values.map(Number));
		case "min":
			return Math.min(...values.map(Number));
		case "hasPrefix":
			return asString(values[0]).startsWith(asString(values[1]));
		case "hasSuffix":
			return asString(values[0]).endsWith(asString(values[1]));
		default:
			throw new ExprError(`unknown function '${name}'`);
	}
}

function trimChars(s: string, chars: string): string {
	let start = 0;
	let end = s.length;
	while (start < end && chars.includes(s[start]!)) start++;
	while (end > start && chars.includes(s[end - 1]!)) end--;
	return s.slice(start, end);
}

function equals(a: Value, b: Value): boolean {
	if (a === b) return true;
	if (a === undefined || a === null) return b === undefined || b === null;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => equals(v, b[i]));
	}
	if (typeof a === "number" && typeof b === "number") return a === b;
	return false;
}

function compare(a: Value, b: Value): number {
	if (typeof a === "string" && typeof b === "string") {
		return a < b ? -1 : a > b ? 1 : 0;
	}
	const x = Number(a);
	const y = Number(b);
	return x < y ? -1 : x > y ? 1 : 0;
}

function asString(v: Value): string {
	if (v === undefined || v === null) return "";
	if (typeof v === "string") return v;
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	return JSON.stringify(v);
}

function asArray(v: Value): Value[] {
	if (Array.isArray(v)) return v;
	if (v === undefined || v === null) return [];
	return [v];
}
