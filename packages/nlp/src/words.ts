/**
 * prose's word tokenizer: the one that produces tokens which know where they
 * came from.
 *
 * # Positions
 *
 * Every token carries an offset into the input, and the invariant
 *
 *     src.slice(tok.start, tok.start + tok.text.length) === tok.text
 *
 * holds for all of them. Two design choices make that true by construction
 * rather than by care:
 *
 *  1. The input is never rewritten before tokenizing. Normalizing curly quotes
 *     to straight ones, or `&rsquo;` to `'`, changes lengths, so every offset
 *     measured against the rewritten copy is wrong for the original.
 *     Characters that would otherwise be normalized are handled directly by
 *     the prefix and suffix sets below.
 *
 *  2. Splitting carries offsets rather than recomputing them. Each split step
 *     slices both the text and its base offset, so a token's position is
 *     always a running sum, never the result of searching for the token's text
 *     in the source, which finds the wrong instance for any repeated word.
 *
 * The Treebank and regexp tokenizers further down produce plain strings
 * instead: Treebank rewrites the text as it splits, so its output cannot carry
 * offsets at all.
 */

import { isEmoticon } from "./tag/emoticon.ts";
import type { Token } from "./token.ts";
import { newToken } from "./token.ts";
import { decodeRune, runeIsSpace } from "./util.ts";

export { newToken, tokenEnd, tokenIn } from "./token.ts";
export type { Token };

const internalRE = /^(?:[A-Za-z]\.){2,}$|^[A-Z][a-z]{1,2}\.$/;

/**
 * Both apostrophe forms are listed. Since the input is never rewritten, the
 * curly forms have to be recognized directly or "It’s" stays one token.
 */
const defaultContractions: readonly string[] = [
	"'ll",
	"'s",
	"'re",
	"'m",
	"n't",
	"’ll",
	"’s",
	"’re",
	"’m",
	"n’t",
];

/**
 * The curly variants are here rather than in a pre-pass replacer: rewriting
 * them to ASCII before tokenizing would shift every subsequent offset.
 * Handling them as ordinary affixes keeps the input intact.
 */
const defaultSuffixes: readonly string[] = [
	",",
	")",
	'"',
	"]",
	"!",
	";",
	".",
	"?",
	":",
	"'",
	"”", // right double quotation mark
	"’", // right single quotation mark
];

const defaultPrefixes: readonly string[] = [
	"$",
	"(",
	'"',
	"[",
	"“", // left double quotation mark
	"‘", // left single quotation mark
];

/** How a `Tokenizer` can be configured. */
export interface TokenizerOptions {
	/** Replaces the characters split off the front of a token. */
	prefixes?: readonly string[];
	/** Replaces the characters split off the end of a token. */
	suffixes?: readonly string[];
	/** Replaces the infixes that trigger a split, such as contraction endings. */
	splitCases?: readonly string[];
	/** An extra predicate for spans that must not be split at all. */
	isSpecial?: (span: string) => boolean;
}

export class Tokenizer {
	private readonly prefixes: readonly string[];
	private readonly suffixes: readonly string[];
	private readonly splitCases: readonly string[];
	private readonly specialRE: RegExp;
	private readonly isSpecial: (span: string) => boolean;

	constructor(opts: TokenizerOptions = {}) {
		this.prefixes = opts.prefixes ?? defaultPrefixes;
		this.suffixes = opts.suffixes ?? defaultSuffixes;
		this.splitCases = opts.splitCases ?? defaultContractions;
		this.specialRE = internalRE;
		this.isSpecial = opts.isSpecial ?? (() => false);
	}

	/** Splits `text` into tokens. */
	tokenize(text: string): Token[] {
		const tokens: Token[] = [];

		let start = 0;
		let index = 0;
		let white = false;
		const length = text.length;

		while (index <= length) {
			const [uc, size] = decodeRune(text, index);
			if (size === 0) break;
			if (index === 0) white = runeIsSpace(uc);
			if (runeIsSpace(uc) !== white) {
				if (start < index) this.split(text.slice(start, index), start, tokens);
				if (uc === 0x20) start = index + 1;
				else start = index;
				white = !white;
			}
			index += size;
		}

		if (start < index) this.split(text.slice(start, index), start, tokens);

		return tokens;
	}

	/**
	 * Breaks one whitespace-delimited span into tokens.
	 *
	 * `base` is the span's offset in the original text; every offset produced
	 * here is `base` plus a distance within the span, so positions stay
	 * anchored to the source no matter how many times the span is subdivided.
	 *
	 * Note that this cannot be memoized by span text: two occurrences of the
	 * same span sit at different offsets.
	 */
	private split(span: string, base: number, tokens: Token[]): void {
		if (blank(span)) return;

		// Suffixes peel off the end, so they are collected in reverse and
		// appended once the core of the span is resolved.
		const suffixes: Token[] = [];

		let s = span;
		let at = base;
		while (s !== "") {
			if (this.special(s)) {
				tokens.push(newToken(s, at));
				s = "";
				break;
			}

			const p = matchPrefix(s, this.prefixes);
			if (p > 0) {
				tokens.push(newToken(s.slice(0, p), at));
				s = s.slice(p);
				at += p;
				continue;
			}

			const idx = indexAnyCase(s, this.splitCases);
			if (idx > 0) {
				// "they'll" -> "they" + "'ll"; "don't" -> "do" + "n't".
				tokens.push(newToken(s.slice(0, idx), at));
				s = s.slice(idx);
				at += idx;
				continue;
			}

			const suf = matchSuffix(s, this.suffixes);
			if (suf > 0) {
				const cut = s.length - suf;
				suffixes.push(newToken(s.slice(cut), at + cut));
				s = s.slice(0, cut);
				continue;
			}

			tokens.push(newToken(s, at));
			s = "";
		}

		// Emit collected suffixes in source order.
		for (let i = suffixes.length - 1; i >= 0; i--) tokens.push(suffixes[i]!);
	}

	/** Whether a span must be kept whole. */
	private special(span: string): boolean {
		return isEmoticon(span) || this.specialRE.test(span) || this.isSpecial(span);
	}
}

/**
 * Whether `s` is empty or entirely whitespace.
 *
 * The scan in `tokenize` advances `start` past a single trailing space, so a
 * run of two or more leaves a whitespace-only span behind. Those are not
 * tokens.
 */
function blank(s: string): boolean {
	for (const r of s) {
		if (!runeIsSpace(r.codePointAt(0) as number)) return false;
	}
	return true;
}

/** The length of the leading prefix, or 0. */
function matchPrefix(s: string, prefixes: readonly string[]): number {
	for (const p of prefixes) {
		if (s.startsWith(p) && s.length > p.length) return p.length;
	}
	return 0;
}

/** The length of the trailing suffix, or 0. */
function matchSuffix(s: string, suffixes: readonly string[]): number {
	for (const suf of suffixes) {
		if (s.endsWith(suf) && s.length > suf.length) return suf.length;
	}
	return 0;
}

/**
 * The offset of the earliest split case in `s`, compared case-insensitively,
 * or -1.
 *
 * Only ASCII case is folded, which is all the default split cases need, and it
 * avoids allocating a lower-cased copy of every span.
 */
function indexAnyCase(s: string, cases: readonly string[]): number {
	let best = -1;
	for (const c of cases) {
		const i = indexFoldASCII(s, c);
		if (i > 0 && (best === -1 || i < best)) best = i;
	}
	return best;
}

function indexFoldASCII(s: string, substr: string): number {
	if (substr.length === 0 || substr.length > s.length) return -1;
	const last = s.length - substr.length;
	for (let i = 0; i <= last; i++) {
		if (equalFoldASCII(s, i, substr)) return i;
	}
	return -1;
}

function equalFoldASCII(s: string, at: number, b: string): boolean {
	for (let i = 0; i < b.length; i++) {
		let ca = s.charCodeAt(at + i);
		let cb = b.charCodeAt(i);
		if (ca >= 0x41 && ca <= 0x5a) ca += 0x20;
		if (cb >= 0x41 && cb <= 0x5a) cb += 0x20;
		if (ca !== cb) return false;
	}
	return true;
}

/** The shared tokenizer with prose's default English behavior. */
let shared: Tokenizer | null = null;

/**
 * prose's tokenizer, built on first use.
 *
 * Vale uses this one rather than the Treebank tokenizer below: Treebank
 * rewrites the text as it splits (quotes become `` and ''), so its tokens are
 * not substrings of the source and cannot carry offsets. Callers such as the
 * `sequence` check need to know where a token actually is.
 */
export function proseTokenizer(): Tokenizer {
	if (shared === null) shared = new Tokenizer();
	return shared;
}

/**
 * A tokenizer that splits on a regular expression.
 *
 * `gaps` means the pattern matches the separators between tokens rather than
 * the tokens themselves; `discard` drops empty results.
 */
export class RegexpTokenizer {
	private readonly source: string;
	private readonly gaps: boolean;
	private readonly discard: boolean;

	constructor(pattern: string, gaps: boolean, discard: boolean) {
		this.source = pattern;
		this.gaps = gaps;
		this.discard = discard;
	}

	tokenize(text: string): string[] {
		if (this.gaps) {
			const parts = text.split(new RegExp(this.source, "u"));
			return this.discard ? parts.filter((s) => s !== "") : parts;
		}
		return text.match(new RegExp(this.source, "gu")) ?? [];
	}
}

/** Splits on any sequence of blank lines. */
export function newBlanklineTokenizer(): RegexpTokenizer {
	return new RegexpTokenizer("\\s*\\n\\s*\\n\\s*", true, true);
}

/** Splits text into a sequence of alphabetic and non-alphabetic characters. */
export function newWordPunctTokenizer(): RegexpTokenizer {
	return new RegexpTokenizer("\\w+|[^\\w\\s]+", false, false);
}

/**
 * Splits text into word-like tokens: this is what `summarize` counts words
 * with.
 */
export function newWordBoundaryTokenizer(): RegexpTokenizer {
	return new RegexpTokenizer("(?:[A-Z]\\.){2,}|[\\p{N}\\p{L}']+", false, false);
}

/**
 * The Treebank word tokenizer.
 *
 * A port of the Sed script by Robert McIntyre, by way of prose. It rewrites
 * the sentence as it splits -- straight quotes become `` and '' -- so its
 * output is a list of strings rather than positioned tokens.
 *
 * Go iterates the replacement tables as maps, whose order is randomized; the
 * patterns in each table are near enough disjoint for that not to matter, and
 * this port applies them in the order they are written so the result is
 * reproducible.
 *
 * NOTE: this expects a sentence, not raw text.
 */
export class TreebankWordTokenizer {
	tokenize(text: string): string[] {
		let s = text;

		for (const [re, sub] of startingQuotes) s = s.replace(re, sub);
		for (const [re, sub] of startingQuotes2) s = s.replace(re, sub);
		for (const [re, sub] of punctuation) s = s.replace(re, sub);
		for (const re of punctuation2) s = s.replace(re, " $1 ");
		for (const [re, sub] of brackets) s = s.replace(re, sub);

		s = ` ${s} `;

		for (const [re, sub] of endingQuotes) s = s.replace(re, sub);
		for (const re of endingQuotes2) s = s.replace(re, "$1 $2 ");
		for (const re of treebankContractions) s = s.replace(re, " $1 $2 ");

		s = s.replace(newlines, " ");
		s = s.replace(spaces, " ").trim();

		return s.split(" ");
	}
}

type Rule = readonly [RegExp, string];

const startingQuotes: readonly Rule[] = [
	[/'([ ([{<])"/g, "$1 `` "],
	[/^(")/g, "``"],
	[/( ")/g, " ``"],
];
const startingQuotes2: readonly Rule[] = [[/(``)/g, " $1 "]];
const punctuation: readonly Rule[] = [
	[/([:,])([^\d])/g, " $1 $2"],
	[/\.\.\./g, " ... "],
	[/([^.])(\.)([\])}>"']*)\s*$/g, "$1 $2$3 "],
	[/([^'])' /g, "$1 ' "],
];
const punctuation2: readonly RegExp[] = [/([:,])$/g, /([;@#$%&?!])/g];
const brackets: readonly Rule[] = [
	[/([[\](){}<>])/g, " $1 "],
	[/--/g, " -- "],
];
const endingQuotes: readonly Rule[] = [[/"/g, " '' "]];
const endingQuotes2: readonly RegExp[] = [
	/'(\S)('')'/g,
	/([^' ])('[sS]|'[mM]|'[dD]|') /g,
	/([^' ])('ll|'LL|'re|'RE|'ve|'VE|n't|N'T) /g,
];
const treebankContractions: readonly RegExp[] = [
	/\b(can)(not)\b/gi,
	/\b(d)('ye)\b/gi,
	/\b(gim)(me)\b/gi,
	/\b(gon)(na)\b/gi,
	/\b(got)(ta)\b/gi,
	/\b(lem)(me)\b/gi,
	/\b(mor)('n)\b/gi,
	/\b(wan)(na) /gi,
	/ ('t)(is)\b/gi,
	/ ('t)(was)\b/gi,
];
const newlines = /(?:\n|\n\r|\r)/g;
const spaces = / {2,}/g;
