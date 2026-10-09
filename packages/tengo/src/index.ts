/**
 * `@vale-ts/tengo` -- an interpreter for the Tengo subset Vale's `script`
 * rules, `metric` formulas and `suggest` actions are written in.
 *
 * Vale embeds [Tengo](https://tengolang.com) in three places, and this package
 * covers all three with the same surface Go's `tengo.Script` gives it:
 *
 * ```ts
 * const script = Script.compile(source, { modules: ["text", "fmt", "math"] });
 * script.add("scope", "");          // declare the global the rule reads
 *
 * const run = script.clone();       // one run; the parsed program is shared
 * run.set("scope", block.text);
 * run.run({ timeoutMs: 2000 });
 * const matches = run.get("matches");
 * ```
 *
 * A `script` rule appends `{begin, end}` maps to a global `matches`; a
 * `suggest` action reads a global `match` and sets `suggestions`; a `metric`
 * formula is compiled inside the boilerplate below and read back out of
 * `__res__`. Compiling is the expensive half, which is why it is separated
 * from running: a rule is compiled once and cloned per block.
 *
 * # Modules
 *
 * `text`, `math` and `fmt` are implemented, which is exactly the set Vale
 * calls `SetImports` with. The set is closed on purpose rather than for want
 * of effort:
 *
 *   - `os` is withheld for the reason Vale withholds it. A style a user
 *     downloaded should not be able to read their files.
 *   - `enum`, `json` and `times` are left out because a rule that imported one
 *     would run here and fail under Go, and the point of this package is to
 *     agree with Go about what a rule does. If Vale ever allows one, it goes
 *     in `interp.ts` beside the other three.
 */

import type { Program } from "./ast.ts";
import { walk } from "./ast.ts";
import { Interpreter, MODULE_NAMES, Scope } from "./interp.ts";
import { parse } from "./parser.ts";
import type { Value } from "./values.ts";
import {
	argFloat,
	argInt,
	fromJS,
	makeBuiltin,
	makeFloat,
	TengoError,
	TengoRuntimeError,
	TengoTimeout,
	toJS,
	wrongArgs,
} from "./values.ts";

export { setPrinter } from "./stdlib/fmt.ts";
export { MODULE_NAMES, TengoError, TengoRuntimeError, TengoTimeout };

/**
 * How a `metric` rule's formula is compiled: as a single expression, with
 * `math` already imported and the result left in `__res__`.
 *
 * Vale substitutes the formula into this text, which is why a formula has to
 * be exactly one expression -- see `describeSource`.
 */
export const METRIC_BOILERPLATE = 'math := import("math"); __res__ := (%s)';

export interface CompileOptions {
	/**
	 * The modules `import` may reach. The default is every module this package
	 * implements; Vale passes `["text", "fmt", "math"]`.
	 */
	modules?: readonly string[];
}

/**
 * A compiled program.
 *
 * Parsing and checking is the expensive part and is done once, here; globals
 * are not shared, so a program can be cloned per block and run concurrently.
 */
export class Script {
	private readonly program: Program;
	private readonly allowed: ReadonlySet<string>;
	/** Globals declared before the program runs, in declaration order. */
	private readonly declared = new Map<string, Value>();

	private constructor(program: Program, allowed: ReadonlySet<string>) {
		this.program = program;
		this.allowed = allowed;
	}

	/**
	 * Parses and prepares `source`, throwing `TengoError` on a syntax error or
	 * on an `import` of a module that is not available.
	 *
	 * Tengo resolves imports when it compiles, so a rule that asks for `os`
	 * fails when the style is loaded rather than when a document is linted.
	 */
	static compile(source: string, options?: CompileOptions): Script {
		const program = parse(source);
		const allowed = new Set(options?.modules ?? MODULE_NAMES);

		for (const stmt of program.body) {
			walk(stmt, (node) => {
				if (node.kind === "import" && !allowed.has(node.module)) {
					throw new TengoError(`module '${node.module}' not found`);
				}
			});
		}

		return new Script(program, allowed);
	}

	/** Declares a global, so the program has a slot for it. */
	add(name: string, value: unknown): void {
		this.declared.set(name, fromJS(value));
	}

	/**
	 * Declares a global holding a function written against this package's own
	 * values, for a host function that has to control int-versus-float.
	 */
	addNative(name: string, call: (args: Value[]) => Value): void {
		this.declared.set(name, makeBuiltin(name, call));
	}

	/** A run with its own globals; the parsed program is shared. */
	clone(): Compiled {
		return new Compiled(this.program, this.allowed, this.declared);
	}
}

/** One run of a compiled program, with its own globals. */
export class Compiled {
	private readonly program: Program;
	private readonly allowed: ReadonlySet<string>;
	/** The globals a run starts from, declared value by declared value. */
	private readonly declared: Map<string, Value>;
	/** The scope the last run used, which `get` reads out of. */
	private globals: Scope;

	constructor(
		program: Program,
		allowed: ReadonlySet<string>,
		declared: ReadonlyMap<string, Value>,
	) {
		this.program = program;
		this.allowed = allowed;
		this.declared = new Map(declared);
		this.globals = this.freshScope();
	}

	private freshScope(): Scope {
		const scope = new Scope(null);
		for (const [name, value] of this.declared) scope.declare(name, value);
		return scope;
	}

	/** Replaces a declared global's value. */
	set(name: string, value: unknown): void {
		if (!this.declared.has(name)) {
			throw new TengoError(`global '${name}' not declared`);
		}
		this.declared.set(name, fromJS(value));
		this.globals = this.freshScope();
	}

	/**
	 * Runs the program, throwing `TengoTimeout` past `timeoutMs`.
	 *
	 * Each run starts from the declared globals, so the same clone can be run
	 * again; Tengo's `Compiled` carries over whatever the previous run defined,
	 * which would make a second run of a program opening with `matches := []`
	 * fail on the redeclaration.
	 */
	run(options?: { timeoutMs?: number }): void {
		this.globals = this.freshScope();
		const interp = new Interpreter(
			this.globals,
			this.allowed,
			options?.timeoutMs ?? 2000,
		);
		interp.run(this.program);
	}

	/** A global's value after the run, as a plain JavaScript value. */
	get(name: string): unknown {
		const value = this.globals.read(name);
		return value === undefined ? undefined : toJS(value);
	}

	/** Every global the run left behind, declared or defined by the program. */
	names(): string[] {
		return this.globals.names();
	}
}

/**
 * How many top-level statements `source` holds, and whether the first is an
 * expression.
 *
 * This is Vale's `checkExpression` as a question rather than an assertion. A
 * `metric` rule's `formula` and `condition` are substituted into
 * `METRIC_BOILERPLATE` as text, so a value carrying its own parentheses or
 * semicolon could parse as several statements rather than the one it is meant
 * to be -- `1) + (2` is the pathological case. Asking here, while the value is
 * still a string, gives a better error than compiling it would.
 */
export function describeSource(source: string): {
	statements: number;
	firstIsExpression: boolean;
} {
	const program = parse(source);
	const first = program.body[0];
	return {
		statements: program.body.length,
		firstIsExpression: first !== undefined && first.kind === "exprStmt",
	};
}

/**
 * Declares the `round(x, places?)` function Vale injects into a metric
 * formula.
 *
 * Tengo's `math` module has `floor`, `ceil` and `trunc` but no `round`, and a
 * grade is reported rounded, so Vale adds one of its own alongside the metric
 * variables. It always returns a float, which is what keeps `round(x) / 2`
 * from turning into integer division.
 *
 * ```ts
 * const script = Script.compile(METRIC_BOILERPLATE.replace("%s", formula));
 * for (const [name, value] of Object.entries(variables)) script.add(name, value);
 * addRound(script);
 * ```
 */
export function addRound(script: Script): void {
	script.addNative("round", (args) => {
		if (args.length < 1 || args.length > 2) throw wrongArgs();
		const x = argFloat(args, 0);
		const places = args.length === 2 ? argInt(args, 1) : 0;
		const scale = 10 ** places;
		// Go's math.Round rounds half away from zero; JavaScript's rounds half
		// up, so a negative half would land on the wrong side.
		const scaled = x * scale;
		const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
		return makeFloat(rounded / scale);
	});
}
