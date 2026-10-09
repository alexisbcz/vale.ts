/**
 * `metric`: an arbitrary, readability-like formula over a block's
 * measurements.
 */

import {
	type Alert,
	type Block,
	blockMetrics,
	type Config,
	type File,
	newE201FromTarget,
	type ValeError,
} from "@vale-ts/core";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	type Definition,
	formatMessages,
	readDefinition,
	readStructureError,
	type Rule,
} from "./definition.ts";
import { isTimeout, tengo } from "./tengo.ts";

const BOILERPLATE = 'math := import("math"); __res__ := (%s)';

/** The element counts a formula may read, whether or not the file has any. */
const VARIABLES = [
	"pre",
	"list",
	"blockquote",
	"heading_h1",
	"heading_h2",
	"heading_h3",
	"heading_h4",
	"heading_h5",
	"heading_h6",
];

const HEADINGS = /heading\.(h[1-6])/g;

/**
 * How long one execution of a rule's program may take, for both `script` rules
 * and the `metric` formulas here.
 *
 * A rule that loops without a way out would otherwise stop Vale with no output
 * and no error, which reads as the tool having crashed rather than as one rule
 * needing attention. Ending the run reports it instead.
 *
 * Generous on purpose: a script matches against a single block and a formula
 * evaluates once per file, so this sits well above what a working rule needs.
 */
export const TENGO_TIMEOUT_MS = 2000;

/**
 * Reports a rule's runtime failure against the rule itself.
 *
 * The path alone identifies the file but not which check inside it stopped,
 * and a package may define several. The name is what appears in a rule's
 * output and in a user's config, so it is the handle they already have for
 * switching the thing off.
 *
 * A deadline is also restated, because the interpreter's own wording is about
 * an internal mechanism and a style author has no reason to connect it to a
 * rule of theirs that never returns.
 */
export function ruleError(
	name: string,
	field: string,
	path: string,
	err: unknown,
	timedOut: boolean,
): ValeError {
	let msg = err instanceof Error ? err.message : String(err);
	if (timedOut) msg = `did not finish within ${TENGO_TIMEOUT_MS / 1000}s`;
	if (name !== "") msg = `${name}: ${msg}`;

	return newE201FromTarget(msg, field, path);
}

export class Metric implements Rule {
	private readonly definition: Definition;

	/** `metric` (`string`): the formula to evaluate. */
	readonly formula: string;
	/** `condition` (`string`): the comparison the result must satisfy. */
	readonly condition: string;

	private readonly path: string;

	constructor(_cfg: Config | null, generic: BaseCheck, path: string) {
		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.formula = f.string("formula");
			this.condition = f.string("condition");
			f.done();
		} catch (err) {
			throw readStructureError(err, path);
		}

		this.path = path;
		this.definition.scope = measuredScope(this.definition.scope);
		this.formula = this.formula.replace(HEADINGS, "heading_$1");
	}

	run(blk: Block, _file: File | null, _cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];

		// A formula is compiled and run as a program, so it needs the same
		// deadline a `script` rule gets. Both evaluations share it, which
		// bounds the rule as a whole rather than each half of it.
		const deadline = Date.now() + TENGO_TIMEOUT_MS;

		const parameters = blockMetrics(blk.summarize(), blk.metrics ?? {});
		if (Object.keys(parameters).length === 0) {
			// An empty file.
			return alerts;
		}

		for (const k of VARIABLES) {
			// A variable the file does not have reads as zero rather than as
			// an unknown name.
			if (parameters[k] === undefined) parameters[k] = 0;
		}

		let res: unknown;
		try {
			res = evalMath(deadline, this.formula, parameters);
		} catch (err) {
			throw ruleError(
				this.definition.name,
				"formula",
				this.path,
				err,
				isTimeout(err),
			);
		}
		if (typeof res !== "number") {
			throw ruleError(
				this.definition.name,
				"formula",
				this.path,
				new Error(`formula did not produce a number: ${String(res)}`),
				false,
			);
		}

		// The condition reads as a comparison against the result, `> 9`, and
		// the result is also `result`, so a condition can bound it from both
		// sides, or weigh it against another count, without repeating the
		// formula: `>= 10 && result < 14`.
		parameters.result = res;
		const eqb = `${res.toFixed(6)} ${this.condition}`;

		let match: unknown;
		try {
			match = evalMath(deadline, eqb, parameters);
		} catch (err) {
			throw ruleError(
				this.definition.name,
				"condition",
				this.path,
				err,
				isTimeout(err),
			);
		}

		if (match === true) {
			const a: Alert = {
				action: { name: "", params: [] },
				suggestions: [],
				check: this.definition.name,
				severity: this.definition.level,
				span: [1, 1],
				link: this.definition.link,
				description: "",
				message: "",
				match: "",
				line: 0,
			};
			[a.message, a.description] = formatMessages(
				this.definition.message,
				this.definition.description,
				res.toFixed(2),
			);
			alerts.push(a);
		}

		return alerts;
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return this.formula;
	}
}

/**
 * The scope a measuring rule runs on.
 *
 * Unset, it measures the document. So does `text`: the document's prose is
 * what the summary holds, and `text` was what an unset scope used to compile
 * to, so a rule that declared it keeps measuring what it always measured. Any
 * other scope measures the blocks it names.
 */
export function measuredScope(declared: readonly string[]): string[] {
	if (declared.length === 0 || (declared.length === 1 && declared[0] === "text")) {
		return ["summary"];
	}
	return [...declared];
}

/**
 * Rejects anything that is not a single expression.
 *
 * A formula is placed into the boilerplate above by substitution, so a value
 * carrying its own parentheses could parse as several statements rather than
 * the one it is meant to be. `condition` is substituted the same way, after
 * the computed value, and needs the same check.
 *
 * Parsing the value on its own settles what it is while it is still a string:
 * anything that is not exactly one expression is a formula this rule cannot
 * evaluate, and saying so here gives a better error than compiling it would.
 */
export function checkExpression(expr: string): void {
	let described: { statements: number; firstIsExpression: boolean };
	try {
		described = tengo().describeSource(expr);
	} catch (err) {
		throw new Error(
			`invalid expression ${JSON.stringify(expr)}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (described.statements !== 1) {
		throw new Error(
			`expected a single expression, found ${described.statements} statements in ${JSON.stringify(expr)}`,
		);
	}
	if (!described.firstIsExpression) {
		throw new Error(
			`expected an expression, found a statement in ${JSON.stringify(expr)}`,
		);
	}
}

/** Evaluates one expression against the block's measurements. */
export function evalMath(
	deadline: number,
	source: string,
	params: Readonly<Record<string, unknown>>,
): unknown {
	const expr = source.trim();
	if (expr === "") throw new Error("empty expression");

	checkExpression(expr);

	// Substituted through a function, so a `$` in the formula is text rather
	// than a replacement pattern.
	const program = BOILERPLATE.replace("%s", () => expr);
	const script = tengo().Script.compile(program, { modules: ["math"] });

	for (const [pk, pv] of Object.entries(params)) script.add(pk, pv);
	script.add("round", round);

	const compiled = script.clone();
	const remaining = Math.max(1, deadline - Date.now());
	compiled.run({ timeoutMs: remaining });

	return compiled.get("__res__");
}

/**
 * The `round(x)` a formula can call, with an optional number of decimal
 * places: `round(x, 1)`.
 *
 * The standard library has floor, ceil and trunc but not this, and a grade is
 * reported rounded. Halves go away from zero, as Go's `math.Round` does and
 * JavaScript's `Math.round` does not.
 */
export function round(...args: unknown[]): number {
	if (args.length < 1 || args.length > 2) {
		throw new Error("wrong number of arguments");
	}

	const x = toNumber(args[0]);
	if (x === null) throw new Error("round: x must be a number");

	let places = 0;
	if (args.length === 2) {
		const p = toNumber(args[1]);
		if (p === null || !Number.isInteger(p)) {
			throw new Error("round: places must be an int");
		}
		places = p;
	}

	const scale = 10 ** places;
	const scaled = x * scale;
	const away = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
	return away / scale;
}

function toNumber(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "bigint") return Number(v);
	return null;
}
