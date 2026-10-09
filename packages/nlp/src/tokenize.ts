/**
 * `IterTokenizer` -- the word extractor Vale uses for spelling and for
 * locating a match within a block.
 *
 * This is not a linguistic tokenizer: it keeps contractions whole ("Don't"
 * stays one token) and drops standalone punctuation. `words.ts` holds prose's
 * tokenizer, which splits the other way, and the two are not interchangeable.
 */

import { emoticonSet } from "./tag/emoticon.ts";
import {
	allNonLetter,
	decodeRune,
	hasAnyPrefix,
	hasAnySuffix,
	runeIsSpace,
	strLen,
} from "./util.ts";

/**
 * Tokens that look like abbreviations and must not be split: `U.S.A.` and
 * `Mr.` both keep their final period.
 */
const internalRE = /^(?:[A-Za-z]\.){2,}$|^[A-Z][a-z]{1,2}\.$/;

/** The replacements Go's `sanitizer` makes, in the order it tries them. */
const SANITIZE: ReadonlyArray<readonly [string, string]> = [
	["“", '"'],
	["”", '"'],
	["‘", "'"],
	["’", "'"],
	["&rsquo;", "'"],
];

const suffixes: readonly string[] = [
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
];
const prefixes: readonly string[] = ["$", "(", '"', "[", "'"];

/**
 * The emoticons the tokenizer keeps whole.
 *
 * `nlp/var.go` carries its own copy of this table, character for character
 * identical to prose's; sharing one set here keeps them from drifting.
 */
const emoticons: ReadonlySet<string> = emoticonSet;

/** Applies the sanitizer's replacements, as `strings.Replacer` would. */
function sanitize(span: string): string {
	let out = span;
	for (const [from, to] of SANITIZE) out = out.replaceAll(from, to);
	return out;
}

/** Adds `s` to `toks` unless it holds no letters at all. */
function addToken(s: string, toks: string[]): void {
	if (!allNonLetter(s)) toks.push(s);
}

/** What `tokenize` returns when asked to locate its tokens. */
export interface LocatedTokens {
	tokens: string[];
	/** Where each token begins, or -1 when it cannot be pointed at. */
	offsets: number[];
}

export class IterTokenizer {
	private readonly specialRE: RegExp;
	private readonly suffixes: readonly string[];
	private readonly prefixes: readonly string[];
	private readonly emoticons: ReadonlySet<string>;

	constructor() {
		this.emoticons = emoticons;
		this.prefixes = prefixes;
		this.specialRE = internalRE;
		this.suffixes = suffixes;
	}

	/** Whether `token` must be kept whole: an emoticon or an abbreviation. */
	isSpecial(token: string): boolean {
		return this.emoticons.has(token) || this.specialRE.test(token);
	}

	/** Strips affixes off one whitespace-delimited run, emitting what is left. */
	doSplit(token: string): string[] {
		const tokens: string[] = [];

		let last = 0;
		let t = token;
		while (t !== "" && strLen(t) !== last) {
			if (this.isSpecial(t)) {
				// A special case (an emoticon, say) is added without any
				// further processing.
				addToken(t, tokens);
				break;
			}
			last = strLen(t);
			if (hasAnyPrefix(t, this.prefixes)) {
				// Remove prefixes -- e.g., $100 -> [$, 100].
				t = t.slice(1);
			} else if (hasAnySuffix(t, this.suffixes)) {
				// Remove suffixes -- e.g., Well) -> [Well, )].
				t = t.slice(0, -1);
			} else {
				addToken(t, tokens);
			}
		}

		return tokens;
	}

	/** Splits a sentence into words. */
	tokenize(text: string): string[] {
		return this.run(text, false).tokens;
	}

	/**
	 * Splits a sentence into words and reports where each one begins.
	 *
	 * An offset is -1 when the word cannot be pointed at: the tokenizer
	 * normalizes curly quotes and entities before splitting, so a word holding
	 * one is not a substring of the text it came from. Callers must treat -1 as
	 * "unknown" rather than as a position.
	 *
	 * This exists so that a check can report where in its block a match was.
	 * The alternative is for the match to be located afterwards by searching
	 * the context for its text, which costs a scan of the whole document per
	 * alert -- and spelling produces alerts by the thousand.
	 */
	tokenizeWithOffsets(text: string): LocatedTokens {
		return this.run(text, true);
	}

	/**
	 * Walks the whitespace-delimited runs of text and splits each one.
	 *
	 * Sanitizing happens per run rather than over the whole text: the
	 * replacements neither introduce nor remove whitespace, so the runs are the
	 * same either way, and doing it here keeps each run's position in the
	 * original text -- which is what an offset has to be measured against.
	 */
	private run(text: string, locate: boolean): LocatedTokens {
		const tokens: string[] = [];
		const offsets: number[] = [];

		const cache = new Map<string, string[]>();
		const split = (span: string): string[] => {
			const found = cache.get(span);
			if (found !== undefined) return found;
			const toks = this.doSplit(sanitize(span));
			cache.set(span, toks);
			return toks;
		};

		const emit = (from: number, to: number): void => {
			const span = text.slice(from, to);
			for (const tok of split(span)) {
				tokens.push(tok);
				if (!locate) continue;
				// Within a single run there is nothing to confuse the search:
				// the token is the run minus whatever the splitter stripped off
				// its ends.
				const i = span.indexOf(tok);
				offsets.push(i >= 0 ? from + i : -1);
			}
		};

		let white = false;
		const length = text.length;
		let start = 0;
		let index = 0;

		while (index <= length) {
			const [uc, size] = decodeRune(text, index);
			if (size === 0) break;
			if (index === 0) white = runeIsSpace(uc);
			if (runeIsSpace(uc) !== white) {
				if (start < index) emit(start, index);
				if (uc === 0x20) start = index + 1;
				else start = index;
				white = !white;
			}
			index += size;
		}

		if (start < index) emit(start, index);

		return { tokens, offsets };
	}
}

/**
 * The shared word tokenizer, matching Go's `nlp.WordTokenizer`.
 *
 * It holds nothing mutable beyond a per-call cache, so one instance serves
 * every caller.
 */
export const wordTokenizer = new IterTokenizer();

/**
 * Splits a sentence into words with the shared tokenizer.
 *
 * The wrapper exists because the tokenizer holds nothing per caller, so every
 * caller wants the one instance -- and naming the function rather than the
 * instance keeps `@vale-ts/core` and `@vale-ts/check` from reaching for a
 * mutable export.
 */
export function tokenizeWords(text: string): string[] {
	return wordTokenizer.tokenize(text);
}

/** `tokenizeWords`, reporting where each word begins. */
export function tokenizeWordsWithOffsets(text: string): LocatedTokens {
	return wordTokenizer.tokenizeWithOffsets(text);
}
