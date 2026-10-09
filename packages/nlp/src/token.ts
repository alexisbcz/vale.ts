/**
 * The token type the whole pipeline speaks.
 *
 * It lives on its own, as prose's `token` package does, so that tokenizing,
 * tagging and segmenting can share one type without any of them pulling in
 * the others' models.
 *
 * # The position invariant
 *
 * `start` is an offset into the text the token came from, and `text` is
 * exactly what is found there:
 *
 *     src.slice(tok.start, tok.start + tok.text.length) === tok.text
 *
 * Everything here that produces tokens maintains this, and it is load-bearing
 * and easy to lose. The common way to break it is to tokenize a *normalized*
 * copy of the input -- replacing curly quotes with straight ones, decoding
 * HTML entities -- and report offsets into that copy. Those replacements
 * change lengths, so every offset after the first replacement points somewhere
 * wrong. So the input is never rewritten before tokenizing; normalization that
 * would shift offsets is the caller's business, done beforehand.
 */

/** A piece of text with its position in the source. */
export interface Token {
	/** The token's content, verbatim from the source. */
	text: string;
	/** The part-of-speech tag, empty until tagged. */
	tag: string;
	/** The IOB entity label, empty until extracted. */
	label: string;
	/** The offset of `text` within the source. */
	start: number;
}

/** Where `tok` ends in the source, exclusive. */
export function tokenEnd(tok: Token): number {
	return tok.start + tok.text.length;
}

/**
 * The token's text as located in `src`, or `""` when the offsets do not fit.
 *
 * Intended for assertions: for any token this package produces,
 * `tokenIn(src, tok) === tok.text`. It returns `""` rather than throwing, so a
 * corrupted token surfaces as a mismatch instead of a crash.
 */
export function tokenIn(src: string, tok: Token): string {
	if (tok.start < 0 || tokenEnd(tok) > src.length) return "";
	return src.slice(tok.start, tokenEnd(tok));
}

/** A new, untagged token. */
export function newToken(text: string, start: number): Token {
	return { text, tag: "", label: "", start };
}
