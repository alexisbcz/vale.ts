/**
 * A cheap test that rules a pattern out before the engine sees it.
 *
 * Running a rule's regular expression costs far more than searching for a
 * word, and almost every rule is asked about text it cannot match: Vale
 * measured a 545-rule style against an 82 KB file at 1.2 million engine runs
 * for 274 alerts, a hit rate of 0.022%.
 *
 * The result is a disjunction -- the subject must contain at least one of the
 * literals returned -- and an empty result means no useful test could be
 * derived. Correctness rests on only ever returning literals a match genuinely
 * must contain: anything uncertain yields nothing, so the prefilter can skip
 * work but never change an answer.
 */

import type { Node } from "./ast.ts";
import { parse } from "./parse.ts";

/**
 * The literals a subject must contain one of, lower-cased.
 *
 * Lower-casing is what lets one filter serve a case-insensitive pattern and a
 * case-sensitive one alike: the caller lower-cases the subject once per block,
 * and a lower-cased literal is required by strictly more subjects than the
 * literal as written.
 */
export function Required(expr: string): string[] {
	let root: Node;
	try {
		root = parse(expr).root;
	} catch {
		return [];
	}

	const lits = literals(root);
	if (lits === null || lits.length === 0) return [];

	const out: string[] = [];
	for (const l of lits) {
		// A single character rules almost nothing out, and costs a scan of the
		// subject to discover it.
		if (l.length < 2) return [];
		out.push(l.toLowerCase());
	}
	return out;
}

/**
 * Scores a literal set by its weakest member, since the subject only has to
 * contain one of them.
 */
export function weight(lits: readonly string[] | null): number {
	if (lits === null || lits.length === 0) return 0;
	let shortest = lits[0]!.length;
	for (const l of lits.slice(1)) {
		if (l.length < shortest) shortest = l.length;
	}
	return shortest;
}

/** A set of strings, one of which any match must contain, or null. */
function literals(n: Node): string[] | null {
	switch (n.kind) {
		case "lit":
			return [n.value];

		case "seq": {
			// Every part must match, so any one part's requirement is the whole
			// expression's. The longest rules out the most.
			let best: string[] | null = null;
			for (const term of n.terms) {
				const got = literals(term);
				if (got !== null && got.length > 0 && weight(got) > weight(best)) {
					best = got;
				}
			}
			return best;
		}

		case "alt": {
			// One branch matches, so a requirement holds only if every branch
			// supplies one; the subject must contain some member of the union.
			const all: string[] = [];
			for (const branch of n.branches) {
				const got = literals(branch);
				if (got === null || got.length === 0) return null;
				all.push(...got);
			}
			return all;
		}

		case "quant":
			// One repetition is mandatory only when the lower bound is positive.
			return n.min > 0 ? literals(n.atom) : null;

		case "group":
			switch (n.type) {
				case "capture":
				case "named":
				case "noncapture":
				case "scoped-flags":
				case "atomic":
					return literals(n.body);
				default:
					// A lookaround constrains a match without contributing to it,
					// so it requires nothing of the subject's text.
					return null;
			}

		// A set of alternatives rather than a string to search for; enumerating
		// one would cost more than the match it replaces. Assertions match a
		// position rather than any text. A backreference's text is whatever the
		// group captured, which is not known here.
		default:
			return null;
	}
}
