/**
 * The default spelling filters, hand-written.
 *
 * A spelling rule runs these against every word of every block, and blocks
 * overlap -- a sentence is also part of a paragraph -- so the same word is
 * tested several times over. Profiling a spell-check of a 120 KB file put 72%
 * of the run inside the regular-expression engine, all of it here.
 *
 * The three patterns are simple enough to read directly, and they are
 * ASCII-only, so a character scan answers each of them exactly. Order matters:
 * `skipsNonWord` is both the cheapest and the most often true, so it goes
 * first.
 */

/** The patterns the scans below replace, kept for the test that pins them. */
export const DEFAULT_FILTERS = [
	/[A-Z]{1}[a-z]+[A-Z]+\w+/,
	/[A-Z]+$/,
	/[^a-zA-Z_']/,
] as const;

function isUpperByte(c: number): boolean {
	return c >= 0x41 && c <= 0x5a;
}

function isLowerByte(c: number): boolean {
	return c >= 0x61 && c <= 0x7a;
}

/** Answers `\w`, which is `[0-9A-Za-z_]` for an ASCII pattern. */
function isWordByte(c: number): boolean {
	return isUpperByte(c) || isLowerByte(c) || (c >= 0x30 && c <= 0x39) || c === 0x5f;
}

/**
 * Whether a word holds anything outside `[^a-zA-Z_']` -- that is, whether
 * that pattern would match.
 *
 * A character above ASCII counts, as it does for the pattern: a character
 * outside the class is one the class does not contain.
 */
export function skipsNonWord(word: string): boolean {
	for (let i = 0; i < word.length; i++) {
		const c = word.charCodeAt(i);
		if (isLowerByte(c) || isUpperByte(c) || c === 0x5f || c === 0x27) continue;
		return true;
	}
	return false;
}

/** Whether `[A-Z]+$` would match: the word ends in at least one capital. */
export function skipsTrailingCaps(word: string): boolean {
	if (word === "") return false;
	return isUpperByte(word.charCodeAt(word.length - 1));
}

/**
 * Whether `[A-Z]{1}[a-z]+[A-Z]+\w+` would match: a capital, one or more
 * lower-case letters, one or more capitals, then a word character.
 *
 * `[A-Z]+` backtracks, which is easy to miss: it can hand a capital back to
 * `\w+`, so two capitals satisfy the tail on their own and nothing need follow
 * them. A greedy scan that consumed every capital and then demanded another
 * word character got `'_0ZaAZ _` wrong.
 */
export function skipsCamel(word: string): boolean {
	for (let i = 0; i < word.length; i++) {
		if (!isUpperByte(word.charCodeAt(i))) continue;

		let j = i + 1;
		while (j < word.length && isLowerByte(word.charCodeAt(j))) j++;
		if (j === i + 1) continue; // no lower-case run

		let k = j;
		while (k < word.length && isUpperByte(word.charCodeAt(k))) k++;
		if (k - j >= 2) {
			// Two capitals: one for `[A-Z]+`, one for `\w+`.
			return true;
		}
		if (k - j === 1 && k < word.length && isWordByte(word.charCodeAt(k))) {
			return true;
		}
	}
	return false;
}

/** Whether any default filter would skip the word. */
export function skippedByDefault(word: string): boolean {
	return skipsNonWord(word) || skipsTrailingCaps(word) || skipsCamel(word);
}

/**
 * Whether a word holds a character no identifier does: anything outside
 * letters, digits, `_`, `-` and `'`.
 */
export function skipsNonIdentifier(word: string): boolean {
	for (const r of word) {
		if (/[\p{L}\p{N}]/u.test(r) || r === "_" || r === "-" || r === "'") continue;
		return true;
	}
	return false;
}

/** One word within an identifier and where it starts. */
export interface IdentifierPart {
	text: string;
	at: number;
}

/**
 * Breaks an identifier at an underscore, a hyphen, a digit, and a change of
 * case: `getHTTPResponse_v2` is get, HTTP, Response, v.
 *
 * The last capital of a run starts the next part, so `HTTPServer` is HTTP and
 * Server. Offsets are string indices into `word`, which is what the caller
 * adds to the word's own position in the block.
 */
export function splitIdentifier(word: string): IdentifierPart[] {
	const parts: IdentifierPart[] = [];
	const chars = [...word];

	let start = -1; // the offset of the current part, or -1
	let at = 0;

	const flush = (end: number): void => {
		if (start >= 0 && end > start) {
			parts.push({ text: word.slice(start, end), at: start });
		}
		start = -1;
	};

	for (let i = 0; i < chars.length; i++) {
		const r = chars[i]!;
		const size = r.length;
		if (!/\p{L}/u.test(r)) {
			flush(at);
		} else if (start < 0) {
			start = at;
		} else if (isUpper(r) && isLower(chars[i - 1]!)) {
			flush(at);
			start = at;
		} else if (
			isUpper(r) &&
			i + 1 < chars.length &&
			isLower(chars[i + 1]!) &&
			isUpper(chars[i - 1]!)
		) {
			flush(at);
			start = at;
		}
		at += size;
	}
	flush(at);

	return parts;
}

function isUpper(c: string): boolean {
	return /\p{Lu}/u.test(c);
}

function isLower(c: string): boolean {
	return /\p{Ll}/u.test(c);
}
