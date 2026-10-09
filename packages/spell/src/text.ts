/**
 * The string primitives this port needs that Go's standard library provides.
 *
 * Go's `strings` and `unicode` differ from JavaScript's in ways that change
 * what a dictionary accepts, so the differences are settled here once instead
 * of at every call site:
 *
 *   - Case mapping. `strings.ToUpper` applies Unicode's *simple* mapping, one
 *     rune to one rune, where `String.prototype.toUpperCase` applies the full
 *     one: it writes ß as SS, expands ligatures, and lower-cases a final Σ to
 *     ς. Hunspell relies on the simple mapping -- CHECKSHARPS exists precisely
 *     because ß has no upper-case form of its own -- so `toUpper` and
 *     `toLower` reproduce it.
 *   - Line and field splitting, which `bufio.Scanner` and `strings.Fields` do
 *     with their own notion of a line ending and of whitespace.
 *
 * # Offsets
 *
 * Where Go indexes a string by byte this port indexes it by UTF-16 code unit,
 * and where Go counts runes it counts code points. The one place the
 * distinction is load-bearing is a Hunspell flag, which Go reads as a byte of
 * the file: `utf8Bytes` hands back those bytes one per character of a
 * Latin-1 string, so a flag stays an ordinary string that can key a map.
 */

const LETTER = /^\p{L}$/u;
const UPPER = /^\p{Lu}$/u;
const DIGIT = /^\p{Nd}$/u;

/** Reports whether `ch`, a single character, is a Unicode letter. */
export function isLetter(ch: string): boolean {
	return LETTER.test(ch);
}

/** Reports whether `ch` is an upper-case letter, Unicode's category Lu. */
export function isUpper(ch: string): boolean {
	return UPPER.test(ch);
}

/** Reports whether `ch` is a decimal digit in any script, category Nd. */
export function isDigit(ch: string): boolean {
	return DIGIT.test(ch);
}

/**
 * The characters whose simple lower-case mapping differs from the full one.
 *
 * Unicode's SpecialCasing lists exactly one unconditional lower-case
 * expansion, İ to `i` plus a combining dot; Go maps it to a bare `i`.
 */
const LOWER_SIMPLE = new Map<string, string>([["İ", "i"]]);

/** How many code points `s` has, which is Go's rune count. */
export function runeCount(s: string): number {
	let n = 0;
	for (const _ of s) n++;
	return n;
}

/** The code points of `s`, which is Go's `[]rune(s)`. */
export function runes(s: string): string[] {
	return Array.from(s);
}

/** The first code point of `s`, or "" when it is empty. */
export function firstRune(s: string): string {
	for (const ch of s) return ch;
	return "";
}

/** Lower-cases `s` with Unicode's simple mapping, as `strings.ToLower` does. */
export function toLower(s: string): string {
	let out = "";
	for (const ch of s) {
		const simple = LOWER_SIMPLE.get(ch);
		if (simple !== undefined) {
			out += simple;
			continue;
		}
		const low = ch.toLowerCase();
		// A mapping that grows the text is the full one, which Go does not
		// apply; the character then stands for itself.
		out += runeCount(low) === 1 ? low : ch;
	}
	return out;
}

/** Upper-cases `s` with Unicode's simple mapping, as `strings.ToUpper` does. */
export function toUpper(s: string): string {
	let out = "";
	for (const ch of s) {
		const up = ch.toUpperCase();
		out += runeCount(up) === 1 ? up : ch;
	}
	return out;
}

/** Upper-cases the first code point, leaving the rest as written. */
export function capitalize(s: string): string {
	if (s === "") return s;
	const first = firstRune(s);
	return toUpper(first) + s.slice(first.length);
}

/** Lower-cases the first code point, leaving the rest as written. */
export function lowerFirst(s: string): string {
	if (s === "") return s;
	const first = firstRune(s);
	return toLower(first) + s.slice(first.length);
}

/**
 * The whitespace `strings.Fields` splits on: Unicode's space characters plus
 * the ones Go's `unicode.IsSpace` adds by hand.
 */
const SPACE_CLASS =
	"[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const SPACE_RUN = new RegExp(`${SPACE_CLASS}+`, "g");
const SPACE_EDGES = new RegExp(`^${SPACE_CLASS}+|${SPACE_CLASS}+$`, "g");

/** Removes leading and trailing whitespace, as `strings.TrimSpace` does. */
export function trimSpace(s: string): string {
	return s.replace(SPACE_EDGES, "");
}

/** Splits `s` around runs of whitespace, as `strings.Fields` does. */
export function fields(s: string): string[] {
	const trimmed = trimSpace(s);
	if (trimmed === "") return [];
	return trimmed.split(SPACE_RUN);
}

/**
 * The lines of `s`, as `bufio.Scanner` yields them: a `\r\n` counts as one
 * ending, and a trailing newline does not make a final empty line.
 */
export function lines(s: string): string[] {
	if (s === "") return [];
	const out = s.split("\n");
	if (out[out.length - 1] === "") out.pop();
	for (let i = 0; i < out.length; i++) {
		const line = out[i] as string;
		if (line.endsWith("\r")) out[i] = line.slice(0, -1);
	}
	return out;
}

const encoder = new TextEncoder();

/**
 * The UTF-8 bytes of `s`, one per character of the returned array.
 *
 * Hunspell reads a flag out of a UTF-8 `.aff` byte by byte, so a non-ASCII
 * flag character is two flags and a class named by one is keyed by its first
 * byte. Returning each byte as a Latin-1 character keeps a flag a string,
 * and the mapping is reversible, so the `.aff` and the `.dic` agree on which
 * flag is which.
 */
export function utf8Bytes(s: string): string[] {
	const bytes = encoder.encode(s);
	const out: string[] = new Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		out[i] = String.fromCharCode(bytes[i] as number);
	}
	return out;
}

/** Escapes the characters a regular expression would read, as `QuoteMeta`. */
export function quoteMeta(s: string): string {
	return s.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");
}

/** Reports whether `s` is one or more ASCII digits, as the `.aff` reader asks. */
export function allDigits(s: string): boolean {
	if (s === "") return false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x30 || c > 0x39) return false;
	}
	return true;
}

/** The largest value `strconv.ParseInt(s, 10, 64)` accepts. */
const MAX_INT64 = 9223372036854775807n;

/**
 * Parses a decimal integer the way `strconv.ParseInt(s, 10, 64)` does,
 * returning null where Go would report an error.
 *
 * The width matters: a `.aff` is data Vale is handed, and the line between a
 * number it can use and one it refuses has to be the same everywhere rather
 * than depend on the host's integer size.
 */
export function parseInt64(s: string): bigint | null {
	if (s === "") return null;
	const negative = s.startsWith("-");
	const digits = negative || s.startsWith("+") ? s.slice(1) : s;
	if (!allDigits(digits)) return null;
	const value = negative ? -BigInt(digits) : BigInt(digits);
	if (value > MAX_INT64 || value < -MAX_INT64 - 1n) return null;
	return value;
}

/** One substitution a `Replacer` applies. */
export type ReplacePair = readonly [string, string];

/**
 * The substitution `strings.NewReplacer` performs: a left-to-right scan that
 * takes the first listed pattern matching at each position and never
 * overlaps a replacement it has already made.
 */
export class Replacer {
	private readonly pairs: readonly ReplacePair[];

	constructor(pairs: readonly ReplacePair[]) {
		this.pairs = pairs.filter(([from]) => from !== "");
	}

	replace(s: string): string {
		let out = "";
		let i = 0;
		while (i < s.length) {
			let matched = false;
			for (const [from, to] of this.pairs) {
				if (s.startsWith(from, i)) {
					out += to;
					i += from.length;
					matched = true;
					break;
				}
			}
			if (!matched) {
				out += s[i];
				i++;
			}
		}
		return out;
	}
}
