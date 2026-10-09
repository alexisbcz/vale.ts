/**
 * The CSS selectors a `doc(...)` scope is written with.
 *
 * Go matches these with `cascadia`; this port compiles them with `css-select`,
 * which reads a `domhandler` tree -- the tree `@vale-ts/lint` builds a
 * document view into. Only compilation lives here, because that is all the
 * rule layer needs: a rule declares a selector, the manager checks that it
 * parses, and the walker that owns the tree does the matching.
 */

import { compile } from "css-select";
import type { AnyNode, Element } from "domhandler";
import { splitOutside } from "./scope.ts";

/** Whether an element of the document view is selected. */
export type DocMatcher = (node: AnyNode) => boolean;

/**
 * Parses a `doc(...)` selector.
 *
 * A group, `h2, h3`, is accepted at the top level as it is inside `:has()`:
 * the single-selector parser stopped at the comma and reported the rest as
 * left over.
 */
export function compileSelector(sel: string): DocMatcher {
	const query = compile<AnyNode, Element>(portableSelector(sel));
	return (node: AnyNode): boolean => query(node as Element);
}

/**
 * A selector in the dialect `css-select` reads, with `cascadia`'s meaning.
 *
 * The rewrites are kept together, and applied where the selector is stored as
 * well as where it is compiled, so the walker that does the matching and the
 * manager that validated it are looking at the same thing.
 */
export function portableSelector(sel: string): string {
	return caseInsensitiveContains(standardSelector(expandHasChild(sel)));
}

/**
 * Spells `:contains()` as `css-select`'s case-insensitive form.
 *
 * `cascadia` compares case-insensitively and `css-select` spells that
 * `:icontains()`. Without the rewrite a heading written `## Methods` is not
 * found by `:contains("methods")`, and a selection that matched nothing is
 * reported as a missing section rather than as the one it is.
 *
 * Walked rather than matched, so a `:contains(` inside a quoted string -- a
 * selector looking for that text -- is left alone.
 */
function caseInsensitiveContains(sel: string): string {
	const lowered = sel.toLowerCase();
	const name = ":contains(";

	let out = "";
	let quote = "";
	let i = 0;

	while (i < sel.length) {
		const r = sel[i]!;
		if (quote !== "") {
			if (r === quote) quote = "";
			out += r;
			i++;
			continue;
		}
		if (r === '"' || r === "'") {
			quote = r;
			out += r;
			i++;
			continue;
		}
		if (lowered.startsWith(name, i)) {
			out += ":icontains(";
			i += name.length;
			continue;
		}
		out += r;
		i++;
	}

	return out;
}

/**
 * Spells `:haschild(...)` in the selector syntax `css-select` parses.
 *
 * `cascadia` has the pseudo-class and `css-select` does not. It selects an
 * element with a *child* matching any of the group, which `:has()` says with
 * a child combinator on each alternative.
 */
function expandHasChild(sel: string): string {
	const lowered = sel.toLowerCase();
	const name = ":haschild(";

	let out = "";
	let quote = "";
	let i = 0;
	while (i < sel.length) {
		const r = sel[i]!;
		if (quote !== "") {
			if (r === quote) quote = "";
			out += r;
			i++;
			continue;
		}
		if (r === '"' || r === "'") {
			quote = r;
			out += r;
			i++;
			continue;
		}
		if (r === ":" && lowered.startsWith(name, i)) {
			const open = i + name.length - 1;
			const close = matchingParen(sel, open);
			if (close < 0) {
				// Unbalanced: left as written so the parser reports it.
				out += sel.slice(i);
				return out;
			}
			const inner = sel.slice(open + 1, close);
			const children = splitOutside(inner, ",")
				.map((part) => `> ${expandHasChild(part.trim())}`)
				.join(", ");
			out += `:has(${children})`;
			i = close + 1;
			continue;
		}
		out += r;
		i++;
	}
	return out;
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function matchingParen(s: string, open: number): number {
	let depth = 0;
	let quote = "";
	for (let i = open; i < s.length; i++) {
		const r = s[i]!;
		if (quote !== "") {
			if (r === quote) quote = "";
			continue;
		}
		if (r === '"' || r === "'") quote = r;
		else if (r === "(") depth++;
		else if (r === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Spells the parts of Selectors Level 4 that the parser does not read in the
 * parts it does.
 *
 * `:is(a, b)` and `:where(a, b)` match an element that matches any of the
 * group, which is `:not(:not(a, b))` exactly; they differ only in specificity,
 * which nothing here reads. The rewrite walks the selector rather than
 * matching it, so a `:is(` inside a quoted string, as in `:contains(":is(")`,
 * is left alone and the closing parenthesis it adds lands on the one that
 * closes the pseudo-class.
 */
export function standardSelector(sel: string): string {
	let out = "";
	let quote = "";
	const extra: number[] = []; // the depth at which each added `:not(` closes
	let depth = 0;

	const lowered = sel.toLowerCase();
	let i = 0;
	while (i < sel.length) {
		const r = sel[i]!;
		let rewritten = false;

		if (quote !== "") {
			if (r === quote) quote = "";
		} else if (r === '"' || r === "'") {
			quote = r;
		} else if (r === ":") {
			for (const name of [":is(", ":where("]) {
				if (lowered.startsWith(name, i)) {
					out += ":not(:not(";
					depth++;
					extra.push(depth);
					i += name.length;
					rewritten = true;
					break;
				}
			}
		} else if (r === "(") {
			depth++;
		} else if (r === ")") {
			if (extra.length > 0 && extra[extra.length - 1] === depth) {
				out += ")";
				extra.pop();
			}
			depth--;
		}

		if (rewritten) continue;
		out += r;
		i++;
	}

	return out;
}
