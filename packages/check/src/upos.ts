/**
 * Universal part-of-speech tags, expressed in terms of the Penn Treebank tags
 * Vale's tagger actually produces.
 *
 * Penn is the finer tagset, so most of this is a straight widening: NOUN is
 * "NN or NNS", ADJ is "JJ, JJR or JJS". Three categories are not expressible
 * that way, because the distinction Penn omits is syntactic rather than
 * morphological:
 *
 *  - Penn has no AUX at all. "have" is VBP whether it is the main verb of
 *    "I have a car" or the auxiliary of "I have eaten".
 *  - IN covers both ADP and SCONJ: "after dinner" and "after we ate".
 *  - TO is PART in "to eat" but ADP in "to the store".
 *
 * Those are approximated with a word list alongside the tag; see `UPOS_WORDS`.
 * The approximation is stated in the docs rather than hidden, because a rule
 * author needs to know that `upos: AUX` means "an auxiliary-looking verb", not
 * "an auxiliary".
 */

import { quoteMeta } from "@vale-ts/regex";

const UPOS_TAGS: Record<string, string> = {
	ADJ: String.raw`JJ|JJR|JJS`,
	ADP: String.raw`IN|RP`,
	ADV: String.raw`RB|RBR|RBS|WRB`,
	AUX: String.raw`MD|VB|VBD|VBG|VBN|VBP|VBZ`,
	CCONJ: String.raw`CC`,
	DET: String.raw`DT|PDT|WDT|WP\$`,
	INTJ: String.raw`UH`,
	NOUN: String.raw`NN|NNS`,
	NUM: String.raw`CD`,
	PART: String.raw`TO|RP|POS`,
	PRON: String.raw`PRP|PRP\$|WP|EX`,
	PROPN: String.raw`NNP|NNPS`,
	PUNCT: String.raw`[.,:]|''|` + "``" + String.raw`|-LRB-|-RRB-|\(|\)`,
	SCONJ: String.raw`IN|WRB`,
	SYM: String.raw`SYM|\$|#`,
	VERB: String.raw`VB|VBD|VBG|VBN|VBP|VBZ`,
	X: String.raw`FW|LS`,
};

/**
 * The categories Penn cannot distinguish on its own.
 *
 * A token must carry both the tag and one of these words to match. Without
 * this, `upos: AUX` would match every verb in the document.
 */
const UPOS_WORDS: Record<string, readonly string[]> = {
	AUX: [
		"am",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"being",
		"have",
		"has",
		"had",
		"having",
		"do",
		"does",
		"did",
		"doing",
		"will",
		"would",
		"shall",
		"should",
		"can",
		"could",
		"may",
		"might",
		"must",
		"ought",
		"'s",
		"'re",
		"'m",
		"'ve",
		"'ll",
		"'d",
	],
	SCONJ: [
		"after",
		"although",
		"as",
		"because",
		"before",
		"even",
		"if",
		"since",
		"so",
		"than",
		"that",
		"though",
		"unless",
		"until",
		"when",
		"whenever",
		"where",
		"whereas",
		"wherever",
		"whether",
		"while",
		"why",
		"how",
	],
};

/**
 * The Penn-tag pattern for a universal tag.
 *
 * Several tags may be given, separated by `|`, for a token that may be any of
 * them -- `PRON|PROPN` for something a pronoun or a name could fill.
 */
export function uposTagPattern(name: string): string {
	const parts = name.split("|");
	const out: string[] = [];

	for (const raw of parts) {
		const part = raw.trim();
		const pattern = UPOS_TAGS[part.toUpperCase()];
		if (pattern === undefined) {
			throw new Error(
				`unknown universal POS tag "${part}"; expected one of ${uposNames().join(", ")}`,
			);
		}
		out.push(pattern);
	}

	return `^(?:${out.join("|")})$`;
}

/**
 * The word-level constraint for a universal tag, or `""` when it needs none.
 *
 * One alternative that accepts any word makes the union accept any word too,
 * so a mixed list such as `AUX|VERB` is unconstrained.
 */
export function uposWordPattern(name: string): string {
	const words: string[] = [];

	for (const raw of name.split("|")) {
		const w = UPOS_WORDS[raw.trim().toUpperCase()];
		if (w === undefined) return "";
		words.push(...w);
	}
	if (words.length === 0) return "";

	return `^(?:${words.map(quoteMeta).join("|")})$`;
}

/** The supported tags, sorted, for an error message. */
export function uposNames(): string[] {
	return Object.keys(UPOS_TAGS).sort();
}
