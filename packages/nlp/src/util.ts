/**
 * The character and string helpers the rest of the package shares.
 *
 * # Offsets
 *
 * Go counts bytes in some places and runes in others. This port has one offset
 * unit -- the JavaScript string index, a UTF-16 code unit -- used wherever Go
 * uses a byte offset into a string, so nothing converts. Where Go counts runes
 * (`utf8.RuneCountInString`, `nlp.StrLen`) this counts code points.
 *
 * The one exception is the part-of-speech model, whose feature keys are
 * genuinely byte-oriented; `tag/tagger.ts` says why and works in UTF-8 there.
 *
 * # Character classes
 *
 * `isSpace` and friends reproduce Go's `unicode` predicates rather than
 * JavaScript's, which disagree in small ways that change where a token ends:
 * JavaScript's `\s` omits U+0085 and includes U+FEFF, while Go's
 * `unicode.IsSpace` does the opposite.
 */

/** Go's `unicode.IsSpace`: the White_Space property, which is not `\s`. */
const SPACE =
	/[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const NUMBER = /\p{N}/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;

/** Whether the character at `s[i]` (or the whole of `s`) is whitespace. */
export function isSpace(ch: string): boolean {
	return SPACE.test(ch);
}

/** Whether `ch` is a letter, as Go's `unicode.IsLetter` decides. */
export function isLetter(ch: string): boolean {
	return LETTER.test(ch);
}

/** Whether `ch` is a decimal digit, as Go's `unicode.IsDigit` decides. */
export function isDigit(ch: string): boolean {
	return DIGIT.test(ch);
}

/** Whether `ch` is a number of any kind, as Go's `unicode.IsNumber` decides. */
export function isNumber(ch: string): boolean {
	return NUMBER.test(ch);
}

/** Whether `ch` is upper case, as Go's `unicode.IsUpper` decides. */
export function isUpper(ch: string): boolean {
	return UPPER.test(ch);
}

/** Whether `ch` is lower case, as Go's `unicode.IsLower` decides. */
export function isLower(ch: string): boolean {
	return LOWER.test(ch);
}

/**
 * The number of code points in `s`, which is what Go's rune count returns.
 *
 * This is `nlp.StrLen`.
 */
export function strLen(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		n++;
		const code = s.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i++;
		}
	}
	return n;
}

/**
 * How many UTF-8 bytes `s` occupies.
 *
 * Needed where Go's `len(s)` is a length test rather than an index -- the
 * "long word" count in `summarize`, for one, calls a word long at more than
 * six bytes.
 */
export function utf8Len(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

/**
 * The code point at `i` and its width in code units, or a width of 0 at the
 * end of the string.
 *
 * This is `utf8.DecodeRuneInString`, which the ported scanners advance by.
 */
export function decodeRune(s: string, i: number): [number, number] {
	if (i < 0 || i >= s.length) return [0, 0];
	const cp = s.codePointAt(i) as number;
	return [cp, cp > 0xffff ? 2 : 1];
}

/** `utf8.DecodeLastRuneInString`: the code point ending at `end`. */
export function decodeLastRune(s: string, end: number): [number, number] {
	if (end <= 0) return [0, 0];
	const lo = s.charCodeAt(end - 1);
	if (lo >= 0xdc00 && lo <= 0xdfff && end >= 2) {
		const hi = s.charCodeAt(end - 2);
		if (hi >= 0xd800 && hi <= 0xdbff) {
			return [(s.codePointAt(end - 2) as number) ?? 0, 2];
		}
	}
	return [lo, 1];
}

/** Whether the code point `cp` is whitespace. */
export function runeIsSpace(cp: number): boolean {
	return cp !== 0 && SPACE.test(String.fromCodePoint(cp));
}

/**
 * Go's `strings.TrimSpace`.
 *
 * `String.prototype.trim` trims a slightly different set, so a ported
 * tokenizer that trimmed with it would disagree with Go about U+0085.
 */
export function trimSpace(s: string): string {
	let start = 0;
	let end = s.length;
	while (start < end) {
		const [cp, size] = decodeRune(s, start);
		if (size === 0 || !runeIsSpace(cp)) break;
		start += size;
	}
	while (end > start) {
		const [cp, size] = decodeLastRune(s, end);
		if (size === 0 || !runeIsSpace(cp)) break;
		end -= size;
	}
	return s.slice(start, end);
}

/** Go's `strings.Fields`: the whitespace-delimited runs of `s`. */
export function fields(s: string): string[] {
	const out: string[] = [];
	let start = -1;
	for (let i = 0; i < s.length; ) {
		const [cp, size] = decodeRune(s, i);
		if (size === 0) break;
		if (runeIsSpace(cp)) {
			if (start >= 0) {
				out.push(s.slice(start, i));
				start = -1;
			}
		} else if (start < 0) {
			start = i;
		}
		i += size;
	}
	if (start >= 0) out.push(s.slice(start));
	return out;
}

/** Whether no character of `s` is a letter. */
export function allNonLetter(s: string): boolean {
	for (const r of s) {
		if (isLetter(r)) return false;
	}
	return true;
}

/**
 * Whether `s` begins with one of `prefixes` and is longer than it.
 *
 * The length test is what stops `"` from being stripped off a bare `"`, which
 * would loop forever.
 */
export function hasAnyPrefix(s: string, prefixes: readonly string[]): boolean {
	for (const prefix of prefixes) {
		if (s.length > prefix.length && s.startsWith(prefix)) return true;
	}
	return false;
}

/** Whether `s` ends with one of `suffixes` and is longer than it. */
export function hasAnySuffix(s: string, suffixes: readonly string[]): boolean {
	for (const suffix of suffixes) {
		if (s.length > suffix.length && s.endsWith(suffix)) return true;
	}
	return false;
}

/**
 * Whether `s` ends with any of `suffixes`, with no length test.
 *
 * This is `strutil.HasAnySuffix`, which `summarize` uses to decide whether a
 * word is complex; `hasAnySuffix` above is the tokenizer's stricter version.
 */
export function endsWithAny(s: string, suffixes: readonly string[]): boolean {
	for (const suffix of suffixes) {
		if (s.endsWith(suffix)) return true;
	}
	return false;
}
