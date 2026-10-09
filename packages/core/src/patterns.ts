/**
 * The shared pattern-building helpers.
 *
 * A vocabulary term is sometimes a literal and sometimes a pattern, and the
 * rules for telling them apart are the same wherever a term is read -- in a
 * vocabulary, in a rule's `exceptions`, in a substitution's swap values. They
 * live here so the three agree.
 */

import { quoteMeta } from "@vale-ts/regex";

/**
 * The whitespace a vocabulary term holds between its words.
 *
 * Matched so it can be widened to also match a line wrap: a phrase in the
 * source may be broken across two lines, and the block's text carries the
 * break.
 */
const WRAP_SPACE = /[ \t]+/g;

/**
 * Whether a term is plain text.
 *
 * A period is allowed, since a name like `Node.js` holds one and never means
 * "any character".
 */
export function literalTerm(term: string): boolean {
	const bare = term.replaceAll(".", "");
	return quoteMeta(bare) === bare;
}

/**
 * A term as a pattern that matches it as written.
 *
 * A term whose only special character is a period is left alone, as in a
 * `.txt` vocabulary, where periods are matched literally.
 */
export function quoteMetaLike(term: string): string {
	return literalTerm(term) ? term : quoteMeta(term);
}

/**
 * A vocabulary term as a pattern.
 *
 * A literal term's periods are escaped, and the whitespace between its words
 * is widened to match a line wrap as well as a space.
 */
export function termPattern(term: string): string {
	let out = term;
	if (literalTerm(out)) out = out.replaceAll(".", "\\.");
	return out.replace(WRAP_SPACE, "\\s+");
}
