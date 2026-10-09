/**
 * A data selector, in the shape of the `dasel` queries Vale's views are
 * written in.
 *
 * `dasel` is a third-party library with no Go source to port, so this is a
 * deliberate subset: the constructs Vale's own views use, and nothing else. A
 * selector it cannot read is an error naming both dialects, as Vale reports.
 *
 * # Supported constructs
 *
 * A selector is a chain of steps joined by `.`, each applied to every value
 * the step before it landed on. The result is one item per hit.
 *
 * | Step                   | Meaning                                              |
 * | ---------------------- | ---------------------------------------------------- |
 * | `name`                 | the property `name` of an object                     |
 * | `name?`                | the same, but an object without it is skipped        |
 * | `all()`                | every element of a list, or every value of an object |
 * | `index(n)`, `[n]`      | the element at `n` of a list                         |
 * | `property(a,b,...)`    | each of the named properties that is present         |
 * | `search(<pred>)`       | every value at or under here that `<pred>` holds for |
 * | `map(<selector>)`      | `<selector>` applied to each element                 |
 * | `filter(<pred>)`       | the elements that `<pred>` holds for                 |
 *
 * A predicate is one of:
 *
 * | Predicate       | Meaning                                                 |
 * | --------------- | ------------------------------------------------------- |
 * | `has("name")`   | the value is an object with a `name` property            |
 * | `equal(a,b)`    | the value's `a` property, as text, is `b`                |
 *
 * The dasel-v2 spelling is accepted too, because Vale falls back to it: a
 * selector may begin with a dot, and `.[]` means every element. v2 has no
 * function steps and no `?`, so `chapters.all().title` is read as v3 and
 * `.chapters.[].title` as v2; a selector neither dialect can read reports both
 * attempts in one message.
 *
 * # Not supported
 *
 * No arithmetic, no comparison operators (`filter(role == "assistant")`), no
 * `$this`, no assignment, no `len()`, `merge()` or the rest of dasel's
 * function library, and no v2 `.(key=value)` filters. Each of those raises the
 * same two-dialect error as a malformed selector.
 *
 * # Flattening
 *
 * Go hands dasel's result through `selectValues`, which casts it to a list and
 * unwraps the single-element wrapper dasel puts around the hits of an `all()`.
 * Here a step is defined over the list of hits directly, so there is no
 * wrapper to unwrap: a hit that is itself a list -- a notebook cell's source,
 * say -- stays one item, which is what a view's `join` then works on.
 */

/** Which spelling a selector is being read in. */
type Dialect = "v3" | "v2";

type Step =
	| { kind: "property"; name: string; optional: boolean }
	| { kind: "all" }
	| { kind: "index"; at: number }
	| { kind: "properties"; names: string[] }
	| { kind: "search"; pred: Pred }
	| { kind: "map"; steps: Step[] }
	| { kind: "filter"; pred: Pred };

type Pred =
	| { kind: "has"; name: string }
	| { kind: "equal"; path: string[]; want: string };

/**
 * Whatever the selector lands on, one item per hit.
 *
 * A selector may be written in either dialect, so a failure in both reports
 * both: the reader knows which one they meant.
 */
export function selectValues(value: unknown, expr: string): unknown[] {
	try {
		return run(value, expr, "v3");
	} catch (v3err) {
		try {
			return run(value, expr, "v2");
		} catch (v2err) {
			throw new Error(`${message(v3err)} (as a v2 selector: ${message(v2err)})`);
		}
	}
}

/** The strings a selector lands on; anything else it lands on is dropped. */
export function selectStrings(value: unknown, expr: string): string[] {
	const out: string[] = [];
	for (const item of selectValues(value, expr)) {
		if (typeof item === "string") out.push(item);
	}
	return out;
}

function run(value: unknown, expr: string, dialect: Dialect): unknown[] {
	return apply(parseSelector(expr, dialect), [value], dialect);
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Parsing

/** Splits a selector into its steps. */
function parseSelector(expr: string, dialect: Dialect): Step[] {
	const segments = splitSegments(expr.trim());
	const steps: Step[] = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		if (seg === "") {
			// A leading dot is v2's; anywhere else an empty segment is a
			// doubled or trailing dot.
			if (i === 0 && segments.length > 1) continue;
			throw new Error(`empty step in selector ${quote(expr)}`);
		}
		steps.push(...parseStep(seg, dialect));
	}

	if (steps.length === 0) throw new Error("empty selector");
	return steps;
}

/**
 * Splits on the dots that separate steps.
 *
 * A dot inside a call's arguments, inside brackets, or inside a quoted string
 * belongs to that step, not between two.
 */
function splitSegments(expr: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quoted = "";
	let start = 0;

	for (let i = 0; i < expr.length; i++) {
		const c = expr[i]!;
		if (quoted !== "") {
			if (c === "\\") i++;
			else if (c === quoted) quoted = "";
			continue;
		}
		switch (c) {
			case '"':
			case "'":
				quoted = c;
				break;
			case "(":
			case "[":
				depth++;
				break;
			case ")":
			case "]":
				depth--;
				if (depth < 0) throw new Error(`unbalanced brackets in ${quote(expr)}`);
				break;
			case ".":
				if (depth === 0) {
					out.push(expr.slice(start, i));
					start = i + 1;
				}
				break;
			default:
				break;
		}
	}
	if (depth !== 0 || quoted !== "") {
		throw new Error(`unbalanced brackets in ${quote(expr)}`);
	}
	out.push(expr.slice(start));
	return out;
}

const CALL_RE = /^([A-Za-z_]\w*)\((.*)\)$/s;
/** A bare property name: anything that is not selector punctuation. */
const NAME_RE = /^[^.[\]()"'?,\s]+$/;

/** Reads one segment, which may be a name followed by subscripts. */
function parseStep(seg: string, dialect: Dialect): Step[] {
	const call = CALL_RE.exec(seg);
	if (call !== null) {
		if (dialect === "v2") {
			throw new Error(`unexpected function call: ${quote(seg)}`);
		}
		return [parseCall(call[1]!, call[2]!)];
	}

	// `name`, `[0]`, `name[0]`, `[]` -- the subscripts trail the name.
	const bracket = seg.indexOf("[");
	const head = bracket < 0 ? seg : seg.slice(0, bracket);
	const tail = bracket < 0 ? "" : seg.slice(bracket);

	const steps: Step[] = [];
	if (head !== "") steps.push(parseProperty(head, dialect, seg));
	else if (tail === "") throw new Error(`empty step: ${quote(seg)}`);

	for (const sub of subscripts(tail, seg)) {
		if (sub === "") {
			if (dialect === "v3") {
				throw new Error(`unexpected "[]": v3 writes it "all()"`);
			}
			steps.push({ kind: "all" });
			continue;
		}
		steps.push({ kind: "index", at: parseIndex(sub, seg) });
	}
	return steps;
}

function parseProperty(head: string, dialect: Dialect, seg: string): Step {
	let name = head;
	let optional = false;
	if (name.endsWith("?")) {
		if (dialect === "v2") {
			throw new Error(`unexpected "?" in ${quote(seg)}`);
		}
		name = name.slice(0, -1);
		optional = true;
	}
	name = unquoted(name);
	if (name === "" || (!NAME_RE.test(name) && !head.startsWith('"'))) {
		throw new Error(`not a property name: ${quote(head)}`);
	}
	return { kind: "property", name, optional };
}

/** The contents of each `[...]` in a trailing run of subscripts. */
function subscripts(tail: string, seg: string): string[] {
	const out: string[] = [];
	let at = 0;
	while (at < tail.length) {
		if (tail[at] !== "[") throw new Error(`cannot read step ${quote(seg)}`);
		const close = tail.indexOf("]", at);
		if (close < 0) throw new Error(`cannot read step ${quote(seg)}`);
		out.push(tail.slice(at + 1, close).trim());
		at = close + 1;
	}
	return out;
}

function parseIndex(text: string, seg: string): number {
	if (!/^-?\d+$/.test(text)) {
		throw new Error(`not an index: ${quote(text)} in ${quote(seg)}`);
	}
	return Number.parseInt(text, 10);
}

function parseCall(name: string, args: string): Step {
	switch (name) {
		case "all":
			if (args.trim() !== "") {
				throw new Error("all() takes no arguments");
			}
			return { kind: "all" };
		case "index": {
			const at = args.trim();
			return { kind: "index", at: parseIndex(at, `index(${args})`) };
		}
		case "property": {
			const names = splitArgs(args).map((a) => unquoted(a));
			if (names.length === 0 || names.some((n) => n === "")) {
				throw new Error("property() needs at least one name");
			}
			return { kind: "properties", names };
		}
		case "search":
			return { kind: "search", pred: parsePred(args) };
		case "filter":
			return { kind: "filter", pred: parsePred(args) };
		case "map":
			return { kind: "map", steps: parseSelector(args.trim(), "v3") };
		default:
			throw new Error(`unknown function: ${quote(name)}`);
	}
}

function parsePred(args: string): Pred {
	const call = CALL_RE.exec(args.trim());
	if (call === null) {
		throw new Error(`not a predicate: ${quote(args.trim())}`);
	}
	const name = call[1]!;
	const inner = call[2]!;

	if (name === "has") {
		const key = unquoted(inner.trim());
		if (key === "") throw new Error("has() needs a property name");
		return { kind: "has", name: key };
	}
	if (name === "equal") {
		const parts = splitArgs(inner);
		if (parts.length !== 2) {
			throw new Error("equal() takes two arguments");
		}
		const path = unquoted(parts[0]!)
			.split(".")
			.filter((p) => p !== "");
		if (path.length === 0) {
			throw new Error("equal() needs a property to compare");
		}
		return { kind: "equal", path, want: unquoted(parts[1]!) };
	}
	throw new Error(`not a predicate: ${quote(name)}`);
}

/** Splits a call's arguments on the commas between them. */
function splitArgs(args: string): string[] {
	if (args.trim() === "") return [];
	const out: string[] = [];
	let depth = 0;
	let quoted = "";
	let start = 0;

	for (let i = 0; i < args.length; i++) {
		const c = args[i]!;
		if (quoted !== "") {
			if (c === "\\") i++;
			else if (c === quoted) quoted = "";
			continue;
		}
		if (c === '"' || c === "'") quoted = c;
		else if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth--;
		else if (c === "," && depth === 0) {
			out.push(args.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(args.slice(start).trim());
	return out;
}

/** Strips the quotes a name or literal may be written with. */
function unquoted(text: string): string {
	const s = text.trim();
	if (s.length >= 2) {
		const first = s[0]!;
		if ((first === '"' || first === "'") && s.endsWith(first)) {
			return s.slice(1, -1);
		}
	}
	return s;
}

// ---------------------------------------------------------------------------
// Evaluation

function apply(steps: Step[], roots: unknown[], dialect: Dialect): unknown[] {
	let current = roots;
	for (const step of steps) {
		const next: unknown[] = [];
		for (const hit of current) step1(step, hit, next, dialect);
		current = next;
	}
	return current;
}

function step1(step: Step, hit: unknown, out: unknown[], dialect: Dialect): void {
	switch (step.kind) {
		case "property": {
			if (!isObject(hit)) {
				if (step.optional) return;
				throw notAMap(hit, step.name, dialect);
			}
			if (!(step.name in hit)) {
				if (step.optional) return;
				throw missing(step.name, dialect);
			}
			out.push(hit[step.name]);
			return;
		}
		case "all": {
			if (Array.isArray(hit)) {
				out.push(...hit);
				return;
			}
			if (isObject(hit)) {
				out.push(...Object.values(hit));
				return;
			}
			throw new Error(`cannot take every element of ${kindOf(hit)}`);
		}
		case "index": {
			if (!Array.isArray(hit)) {
				throw new Error(`cannot index ${kindOf(hit)}`);
			}
			if (step.at < 0 || step.at >= hit.length) {
				throw new Error(`index ${step.at} is out of range`);
			}
			out.push(hit[step.at]);
			return;
		}
		case "properties": {
			if (!isObject(hit)) {
				throw notAMap(hit, step.names.join(","), dialect);
			}
			for (const name of step.names) {
				if (name in hit) out.push(hit[name]);
			}
			return;
		}
		case "search": {
			for (const node of descendants(hit)) {
				if (holds(step.pred, node)) out.push(node);
			}
			return;
		}
		case "filter": {
			// A list is filtered over its elements; anything else stands for
			// the one-element list holding it, which is what makes
			// `all().filter(...)` read as a filter over the elements `all()`
			// landed on rather than over each of them in turn.
			for (const item of Array.isArray(hit) ? hit : [hit]) {
				if (holds(step.pred, item)) out.push(item);
			}
			return;
		}
		case "map": {
			// A list is mapped over its elements; anything else is mapped over
			// itself, which is what makes `search(...).map(name)` read as the
			// name of each value the search found.
			const items = Array.isArray(hit) ? hit : [hit];
			out.push(...apply(step.steps, items, dialect));
			return;
		}
		default:
			return;
	}
}

/** The value and everything under it, in document order. */
function* descendants(value: unknown): Generator<unknown> {
	yield value;
	if (Array.isArray(value)) {
		for (const item of value) yield* descendants(item);
	} else if (isObject(value)) {
		for (const item of Object.values(value)) yield* descendants(item);
	}
}

function holds(pred: Pred, value: unknown): boolean {
	switch (pred.kind) {
		case "has":
			return isObject(value) && pred.name in value;
		case "equal": {
			let at: unknown = value;
			for (const name of pred.path) {
				if (!isObject(at) || !(name in at)) return false;
				at = at[name];
			}
			return asText(at) === pred.want;
		}
		default:
			return false;
	}
}

function asText(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The name a message gives a value's type, as dasel's messages do. */
function kindOf(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "map";
	return typeof value;
}

/**
 * The two dialects word a property step's failures differently, and Vale's
 * users see both wordings in one message.
 */
function notAMap(hit: unknown, name: string, dialect: Dialect): Error {
	if (dialect === "v2") {
		return new Error(
			`cannot use property selector on non map/struct types: ${kindOf(hit)}: property not found: ${name}`,
		);
	}
	return new Error(`unexpected type: expected map, got ${kindOf(hit)}`);
}

function missing(name: string, dialect: Dialect): Error {
	if (dialect === "v2") return new Error(`property not found: ${name}`);
	return new Error(`property ${quote(name)} not found`);
}

function quote(s: string): string {
	return JSON.stringify(s);
}
