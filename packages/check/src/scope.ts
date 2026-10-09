/**
 * Scopes and selectors: which blocks of a document a rule runs on.
 *
 * A block carries a dotted selector the reader gave it -- `text.heading.h2.md`
 * -- and a rule carries one or more scope expressions. A rule matches a block
 * when every section of one of its expressions appears in the block's.
 *
 * Parsed scopes and selectors are cached rather than rebuilt. Both are derived
 * from strings fixed for the life of a run: a rule's scope comes from its
 * definition and a block's from the reader. But they were parsed afresh for
 * every rule against every block, which for a large style is millions of
 * times; in Go that was roughly 70% of everything Vale allocated. The parsed
 * values are read-only, so one copy serves every caller.
 */

import type { Block } from "@vale-ts/core";
import { allStringsInSlice, fnv32a, stringInSlice } from "./util.ts";

const scopeCache = new Map<string, Scope>();
const selectorCache = new Map<string, Selector>();

/** Parses a dotted scope string, reusing an earlier parse. */
export function cachedSelector(value: string): Selector {
	const hit = selectorCache.get(value);
	if (hit !== undefined) return hit;
	const sel = newSelector(value.split("."));
	selectorCache.set(value, sel);
	return sel;
}

/** A named section of text. */
export class Selector {
	/** The terms as written, such as `text.comment.line.py`. */
	readonly value: readonly string[];
	/** Whether the selector excludes rather than selects. */
	readonly negated: boolean;

	/**
	 * `value` split on `.`, computed once.
	 *
	 * `contains` reads the sections of both operands, so a single scope
	 * comparison used to re-split both selectors; with a rule run against
	 * every block that was 40% of everything Vale allocated after the scope
	 * cache landed.
	 */
	private readonly parts: readonly string[];

	constructor(
		value: readonly string[],
		negated: boolean,
		parts?: readonly string[],
	) {
		this.value = value;
		this.negated = negated;
		this.parts = parts ?? splitSections(value);
	}

	/** The selector's parts: `text.comment.line.py` is four of them. */
	sections(): readonly string[] {
		return this.parts;
	}

	/** Whether every one of `sel`'s sections is in this one's. */
	contains(sel: Selector): boolean {
		return allStringsInSlice(sel.sections(), this.sections());
	}

	/** Whether every scope in `scope` is contained. */
	containsString(scope: readonly string[]): boolean {
		for (const option of scope) {
			if (!this.contains(new Selector([option], false))) return false;
		}
		return true;
	}

	/** Whether the two selectors were written the same way. */
	equal(sel: Selector): boolean {
		if (this.value.length !== sel.value.length) return false;
		return this.value.every((v, i) => sel.value[i] === v);
	}

	/** Whether one of the selector's parts is `scope`. */
	has(scope: string): boolean {
		return stringInSlice(scope, this.sections());
	}
}

/** Flattens dotted terms into their sections. */
function splitSections(value: readonly string[]): string[] {
	const parts: string[] = [];
	for (const m of value) parts.push(...m.split("."));
	return parts;
}

/** A selector from its dotted terms, reading a leading `~` as a negation. */
export function newSelector(value: readonly string[]): Selector {
	let negated = false;
	const parts: string[] = [];

	for (let i = 0; i < value.length; i++) {
		let m = value[i]!.trim();
		if (i === 0 && m.startsWith("~")) {
			m = m.slice(1);
			negated = true;
		}
		parts.push(m);
	}

	return new Selector(parts, negated, splitSections(parts));
}

/** The scopes an inline element carries on its own. */
export const INLINE_SCOPES: ReadonlySet<string> = new Set([
	"link",
	"strong",
	"emphasis",
	"code",
	"quote",
]);

/** A rule's declared scope, compiled. */
export class Scope {
	/** The AND-ed parts of each declared expression, by the expression. */
	readonly selectors: Map<string, Selector[]>;

	/**
	 * The inline scopes the rule negates, such as `link`: the text of those
	 * elements is left out of the blocks the rule runs on.
	 */
	readonly excluded: string[];

	constructor(selectors: Map<string, Selector[]>, excluded: string[]) {
		this.selectors = selectors;
		this.excluded = excluded;
	}

	/** Whether this scope reaches `blk`. */
	matches(blk: Block): boolean {
		const candidate = cachedSelector(blk.scope);
		const parent = cachedSelector(blk.parent);

		// A sentence fragment's scope is its parent's plus `sentence`, so any
		// selector it satisfies without naming `sentence` is satisfied by the
		// parent block too -- and that is the copy such a rule must see: a
		// `scope: heading` rule reading a heading one fragment at a time
		// reported `a.` as a whole heading.
		const fragment = blk.scope.startsWith("sentence.");

		for (const sel of this.selectors.values()) {
			if (fragment && !asksForSentence(sel)) continue;
			if (partMatches(candidate, parent, sel)) return true;
		}

		return false;
	}
}

/** Whether any of the AND-ed parts names `sentence` without negating it. */
function asksForSentence(options: readonly Selector[]): boolean {
	return options.some((part) => !part.negated && part.has("sentence"));
}

function partMatches(
	target: Selector,
	parent: Selector,
	options: readonly Selector[],
): boolean {
	for (const part of options) {
		const tm = target.contains(part);
		if (!part.negated) {
			if (!tm) return false;
			continue;
		}
		// A negated part excludes the element and whatever is inside it.
		const pm = parent.contains(part);
		if (tm || pm) return false;
		if (target.has("raw") || target.has("summary") || target.has("doc")) {
			// This cannot apply to sized scopes, nor to a selection, whose
			// text is linted where it lies.
			return false;
		}
	}
	return true;
}

/** A rule's scope, compiled once per set of expressions. */
export function newScope(value: readonly string[]): Scope {
	const key = value.join("\u0000");
	const hit = scopeCache.get(key);
	if (hit !== undefined) return hit;

	const selectors = new Map<string, Selector[]>();
	for (const v of value) {
		const parts = splitOutside(v, "&");
		selectors.set(
			v,
			parts.map((part) => newPart(part, parts.length === 1)),
		);
	}

	const excluded: string[] = [];
	for (const parts of selectors.values()) {
		for (const part of parts) {
			if (
				part.negated &&
				part.value.length === 1 &&
				INLINE_SCOPES.has(part.value[0]!)
			) {
				excluded.push(part.value[0]!);
			}
		}
	}

	const built = new Scope(selectors, excluded);
	scopeCache.set(key, built);
	return built;
}

/**
 * Parses one `&`-separated term of a scope.
 *
 * A `doc(...)` term names elements of the document view by CSS selector. On
 * its own it selects the matched element as a block, `doc.<id>`; beside
 * another term, or negated, it narrows to blocks inside the element, which
 * carry `in.<id>`.
 */
function newPart(part: string, standalone: boolean): Selector {
	let term = part.trim();
	const negated = term.startsWith("~");
	if (negated) term = term.slice(1);

	const sel = docSelection(term);
	if (sel === null) return newSelector(part.split("."));

	const kind = standalone && !negated ? "doc" : "in";
	return new Selector([term], negated, [kind, docID(sel)]);
}

/** The selector inside a `doc(...)` term, or null when it is not one. */
function docSelection(term: string): string | null {
	if (term.startsWith("doc(") && term.endsWith(")")) {
		return term.slice("doc(".length, term.length - 1);
	}
	return null;
}

/**
 * Names a selector.
 *
 * Derived from the selector's text so that a rule and the document walker
 * agree on it without sharing state.
 */
export function docID(sel: string): string {
	return fnv32a(sel);
}

/** The `doc(...)` selectors a scope declares, each under its id. */
export function docSelectorMap(scope: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const part of splitOutside(scope, "&")) {
		const term = stripNegation(part.trim());
		const sel = docSelection(term);
		if (sel !== null) found.set(docID(sel), sel);
	}
	return found;
}

/** The `doc(...)` selectors a scope declares, as written. */
export function docSelectors(scope: string): string[] {
	return [...docSelectorMap(scope).values()];
}

function stripNegation(term: string): string {
	return term.startsWith("~") ? term.slice(1) : term;
}

/**
 * Splits `s` on `sep`, leaving alone any `sep` inside parentheses or quotes --
 * the `&`, `.` and `~` a CSS selector may contain are its own.
 */
export function splitOutside(s: string, sep: string): string[] {
	const parts: string[] = [];
	let quote = "";
	let depth = 0;
	let start = 0;

	for (let i = 0; i < s.length; i++) {
		const r = s[i]!;
		if (quote !== "") {
			if (r === quote) quote = "";
		} else if (r === '"' || r === "'") {
			quote = r;
		} else if (r === "(") {
			depth++;
		} else if (r === ")") {
			if (depth > 0) depth--;
		} else if (r === sep && depth === 0) {
			parts.push(s.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(s.slice(start));
	return parts;
}

/**
 * Replaces each named scope in a rule's `scope` with the expression it names.
 *
 * A `scope` is a string or a list, and comes back as a list either way; an
 * unset scope stays unset, since its default depends on the check.
 */
export function expandScopes(
	value: unknown,
	names: Readonly<Record<string, string>>,
): string[] | null {
	let declared: string[];
	if (value === null || value === undefined) return null;
	if (typeof value === "string") declared = [value];
	else if (Array.isArray(value)) declared = value.map((item) => String(item));
	else throw new Error(`'${String(value)}' is not a scope`);

	const expanded: string[] = [];
	for (const scope of declared) {
		const parts = splitOutside(scope, "&");
		for (let i = 0; i < parts.length; i++) {
			const term = parts[i]!.trim();
			const negated = term.startsWith("~");
			const name = negated ? term.slice(1) : term;

			parts[i] = term;
			const expr = names[name];
			if (expr === undefined) continue;

			if (splitOutside(expr, "&").length > 1) {
				if (negated) {
					throw new Error(
						`'~${name}' negates a chain, '${expr}', which has no opposite`,
					);
				}
				// A chain joins the rule's own terms: its `doc(...)` no longer
				// stands alone, which is what a chain asks for anyway.
				parts[i] = expr;
				continue;
			}
			parts[i] = negated ? `~${expr}` : expr;
		}
		expanded.push(parts.join(" & "));
	}

	return expanded;
}

/**
 * The block families a declared scope needs built.
 *
 * A scope may chain terms with `&`, and each term asks for its own family:
 * `paragraph & ~heading` needs paragraph splitting as much as `paragraph`
 * does. Reading the whole chain as one name left `hasScope` false, splitting
 * off, and the rule silently matching nothing.
 *
 * A negated term asks for a family's absence, which needs nothing built,
 * except for an inline element: leaving `~link` out of a block needs the
 * links captured.
 */
export function scopeBases(s: string): string[] {
	const bases: string[] = [];
	for (const raw of splitOutside(s, "&")) {
		const part = raw.trim();
		if (part.startsWith("doc(")) continue;
		if (part.startsWith("~")) {
			const base = part.slice(1);
			if (INLINE_SCOPES.has(base)) bases.push(base);
			continue;
		}
		bases.push(part.split(".")[0]!);
	}
	return bases;
}
