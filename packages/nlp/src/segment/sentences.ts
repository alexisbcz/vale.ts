/**
 * The Punkt engine, ported from `gopkg.in/neurosnap/sentences`.
 *
 * Punkt decides sentence boundaries from a trained model rather than from
 * punctuation alone: `Dr. Smith` does not end a sentence because the training
 * data says `dr` is an abbreviation, and `No. 5` does not because `no` and
 * `##number##` occur together. The model lives in `@vale-ts/models`; this file
 * is only the machinery that reads it.
 *
 * The structure follows the upstream files -- storage, punctuation, token,
 * word tokenizer, annotations, ortho -- so that a reader comparing the two can
 * do it side by side. prose's customizations sit in `punkt.ts`.
 */

import type { PunktTraining } from "@vale-ts/models";
import {
	decodeRune,
	isLower,
	isUpper,
	runeIsSpace,
	strLen,
	trimSpace,
} from "../util.ts";

/**
 * The orthographic contexts a word can occur in. BEG=beginning, MID=middle,
 * UNK=unknown, UC=upper case, LC=lower case.
 */
export const ORTHO_BEG_UC = 1 << 1;
export const ORTHO_MID_UC = 1 << 2;
export const ORTHO_UNK_UC = 1 << 3;
export const ORTHO_BEG_LC = 1 << 4;
export const ORTHO_MID_LC = 1 << 5;
export const ORTHO_UNK_LC = 1 << 6;
/** Occurs with upper case. */
export const ORTHO_UC = ORTHO_BEG_UC + ORTHO_MID_UC + ORTHO_UNK_UC;
/** Occurs with lower case. */
export const ORTHO_LC = ORTHO_BEG_LC + ORTHO_MID_LC + ORTHO_UNK_LC;

/**
 * The trained model, as the annotators read it.
 *
 * Upstream this is `Storage`, four `map[string]int` sets. Maps rather than the
 * plain objects `@vale-ts/models` parses: lookup is the inner loop of
 * annotation, and a `Map` neither inherits keys from `Object.prototype` nor
 * has to be guarded against `"constructor"` arriving as a token type.
 */
export class Storage {
	readonly abbrevTypes: Map<string, number>;
	readonly collocations: Map<string, number>;
	readonly sentStarters: Map<string, number>;
	readonly orthoContext: Map<string, number>;

	constructor(training: PunktTraining) {
		this.abbrevTypes = new Map(Object.entries(training.AbbrevTypes));
		this.collocations = new Map(Object.entries(training.Collocations));
		this.sentStarters = new Map(Object.entries(training.SentStarters));
		this.orthoContext = new Map(Object.entries(training.OrthoContext));
	}

	/** Adds an abbreviation the training data missed. */
	addAbbrev(abbr: string): void {
		this.abbrevTypes.set(abbr, 1);
	}

	/** Whether any of `tokens` is a known abbreviation. */
	isAbbr(...tokens: string[]): boolean {
		for (const token of tokens) {
			if ((this.abbrevTypes.get(token) ?? 0) !== 0) return true;
		}
		return false;
	}

	/** The orthographic flags recorded for a token type. */
	ortho(typ: string): number {
		return this.orthoContext.get(typ) ?? 0;
	}

	/** How often `typ` started a sentence in training. */
	sentStarter(typ: string): number {
		return this.sentStarters.get(typ) ?? 0;
	}

	/** Whether `before,after` is a known collocation. */
	collocation(pair: string): number {
		return this.collocations.get(pair) ?? 0;
	}
}

/** The punctuation the tokenizer recognizes. */
export class PunctStrings {
	/** A pattern matching a character that is neither punctuation nor a digit. */
	nonPunct(): string {
		return "[^\\W\\d]";
	}

	/** The punctuation characters. */
	punctuation(): string {
		return ";:,.!?；：，。！？";
	}

	/** Whether `text` holds a character that can end a sentence. */
	hasSentencePunct(text: string): boolean {
		const endPunct = ".!?。！？";
		for (const char of endPunct) {
			for (const achar of text) {
				if (char === achar) return true;
			}
		}
		return false;
	}
}

const reEllipsis = /\.\.+$/;
const reNumeric = /-?[.,]?\d[\d,.-]*\.?$/;
const reInitial = /^[A-Za-z]\.$/;
const reAlpha = /^[A-Za-z]+$/;

/** One word, with the annotations boundary detection produces. */
export class PunktToken {
	tok: string;
	/** Where the token ends in the source. */
	position = 0;
	sentBreak = false;
	paraStart = false;
	lineStart = false;
	abbr = false;

	constructor(tok: string) {
		this.tok = tok;
	}
}

/** Pairs each token with the one after it, the last with null. */
export function groupTokens(
	tokens: PunktToken[],
): Array<[PunktToken, PunktToken | null]> {
	if (tokens.length === 0) return [];

	const pairs: Array<[PunktToken, PunktToken | null]> = [];
	let prev = tokens[0]!;
	for (const tok of tokens) {
		if (prev === tok) continue;
		pairs.push([prev, tok]);
		prev = tok;
	}
	pairs.push([prev, null]);

	return pairs;
}

/** Whether `r` is one of the CJK characters that end a sentence on their own. */
function isCjkPunct(cp: number): boolean {
	switch (cp) {
		case 0x3002: // 。
		case 0xff1b: // ；
		case 0xff01: // ！
		case 0xff1f: // ？
			return true;
		default:
			return false;
	}
}

/**
 * The word tokenizer Punkt annotates, plus the type and case predicates the
 * annotators ask it for.
 *
 * `segment/punkt.ts` subclasses this to override `hasSentEndChars`, which is
 * prose's one change to the upstream behavior.
 */
export class WordTokenizer {
	readonly punctStrings: PunctStrings;
	private readonly nonPunctRE: RegExp;

	constructor(punctStrings: PunctStrings) {
		this.punctStrings = punctStrings;
		this.nonPunctRE = new RegExp(punctStrings.nonPunct());
	}

	/**
	 * Breaks text into words, keeping each one's end position and whether it
	 * starts a line or a paragraph.
	 *
	 * With `onlyPeriodContext` only the words around sentence-ending
	 * punctuation are kept, which is everything the annotators look at and a
	 * fraction of the tokens.
	 */
	tokenize(text: string, onlyPeriodContext: boolean): PunktToken[] {
		const textLength = text.length;
		if (textLength === 0) return [];

		const tokens: PunktToken[] = [];
		let lastSpace = 0;
		let lineStart = false;
		let paragraphStart = false;
		let getNextWord = false;

		for (let scan = 0; scan < textLength; ) {
			const [char, size] = decodeRune(text, scan);
			// `idx` is Go's loop variable, which the body may advance past a
			// CJK mark; the scan itself advances independently.
			let idx = scan;
			scan += size;

			if (!runeIsSpace(char) && !isCjkPunct(char) && idx !== textLength - 1) {
				continue;
			}

			if (isCjkPunct(char)) idx += size;

			if (char === 0x0a) {
				if (lineStart) paragraphStart = true;
				lineStart = true;
			}

			const cursor = idx === textLength - 1 ? textLength : idx;
			const word = trimSpace(text.slice(lastSpace, cursor));
			if (word === "") continue;

			const hasSentencePunct = this.punctStrings.hasSentencePunct(word);
			if (onlyPeriodContext && !hasSentencePunct && !getNextWord) {
				lastSpace = cursor;
				continue;
			}

			const token = new PunktToken(word);
			token.position = cursor;
			token.paraStart = paragraphStart;
			token.lineStart = lineStart;
			tokens.push(token);

			lastSpace = cursor;
			lineStart = false;
			paragraphStart = false;
			getNextWord = hasSentencePunct;
		}

		if (tokens.length === 0) {
			const token = new PunktToken(text);
			token.position = textLength;
			tokens.push(token);
		}

		return tokens;
	}

	/** A case-normalized representation of the token. */
	type(t: PunktToken): string {
		const typ = t.tok.toLowerCase().replace(reNumeric, "##number##");
		if (typ.length === 1) return typ;
		return typ.replaceAll(",", "");
	}

	/** The type with its final period removed if it has one. */
	typeNoPeriod(t: PunktToken): string {
		const typ = this.type(t);
		if (typ.length > 1 && typ.endsWith(".")) return typ.slice(0, -1);
		return typ;
	}

	/** The type with its final period removed if it is marked a sentence break. */
	typeNoSentPeriod(t: PunktToken): string {
		return t.sentBreak ? this.typeNoPeriod(t) : this.type(t);
	}

	/** Whether the token's first character is upper case. */
	firstUpper(t: PunktToken): boolean {
		if (t.tok === "") return false;
		return isUpper(String.fromCodePoint(t.tok.codePointAt(0) as number));
	}

	/** Whether the token's first character is lower case. */
	firstLower(t: PunktToken): boolean {
		if (t.tok === "") return false;
		return isLower(String.fromCodePoint(t.tok.codePointAt(0) as number));
	}

	/** Whether the token is an ellipsis. */
	isEllipsis(t: PunktToken): boolean {
		return reEllipsis.test(t.tok);
	}

	/** Whether the token is a number. */
	isNumber(t: PunktToken): boolean {
		return t.tok.startsWith("##number##");
	}

	/** Whether the token is an initial, as in `J. Bach`. */
	isInitial(t: PunktToken): boolean {
		return reInitial.test(t.tok);
	}

	/** Whether the token is all alphabetic. */
	isAlpha(t: PunktToken): boolean {
		return reAlpha.test(t.tok);
	}

	/** Whether the token is either a number or alphabetic. */
	isNonPunct(t: PunktToken): boolean {
		return this.nonPunctRE.test(this.type(t));
	}

	/** Whether the token's last character is a period. */
	hasPeriodFinal(t: PunktToken): boolean {
		return t.tok.endsWith(".") || t.tok.endsWith("。");
	}

	/** Whether the token ends in punctuation that closes a sentence. */
	hasSentEndChars(t: PunktToken): boolean {
		const enders = [
			'."',
			".'",
			".)",
			"?",
			'?"',
			"?'",
			"?)",
			"!",
			'!"',
			"!'",
			"!)",
			"!’",
			"!”",
			"。”",
			"。’",
			"。）",
			"？",
			"？”",
			"？’",
			"？）",
			"！",
			"！”",
			"！’",
			"！）",
		];
		for (const ender of enders) {
			if (t.tok.endsWith(ender)) return true;
		}

		const parens = [
			".[",
			".(",
			'."',
			".'",
			"?[",
			"?(",
			"![",
			"!(",
			"。【",
			"。（",
			"。”",
			"。’",
			"？【",
			"？（",
			"！【",
			"！（",
		];
		for (const paren of parens) {
			if (t.tok.includes(paren)) return true;
		}

		return false;
	}
}

/** What an annotation pass does to a run of tokens. */
export interface Annotation {
	annotate(tokens: PunktToken[]): PunktToken[];
}

/**
 * The first pass, which decides from each word's type alone:
 *
 *  - `?`, `!` and `.` are marked as sentence breaks;
 *  - any word ending in `.` that is a known abbreviation is marked as one;
 *  - any other word ending in `.` is marked as a sentence break.
 */
export class TypeBasedAnnotation implements Annotation {
	constructor(
		private readonly storage: Storage,
		private readonly word: WordTokenizer,
	) {}

	annotate(tokens: PunktToken[]): PunktToken[] {
		for (const tok of tokens) this.typeAnnotation(tok);
		return tokens;
	}

	private typeAnnotation(token: PunktToken): void {
		if (this.word.hasSentEndChars(token)) {
			token.sentBreak = true;
			return;
		}
		if (!this.word.hasPeriodFinal(token) || token.tok.endsWith("..")) return;

		// Upstream slices the token's *bytes* by its *rune* count, which drops
		// the final character only for an all-ASCII token and truncates
		// otherwise. Reproduced here -- with code points standing in for runes
		// and code units for bytes -- because the trained model and every
		// expected segmentation were produced with this behavior.
		const tokNoPeriod = token.tok.slice(0, strLen(token.tok) - 1).toLowerCase();
		const parts = tokNoPeriod.split("-");
		const tokLastHyphEl = parts[parts.length - 1]!;

		if (this.storage.isAbbr(tokNoPeriod, tokLastHyphEl)) token.abbr = true;
		else token.sentBreak = true;
	}
}

/**
 * The second pass: a token-based classification (section 4 of the Punkt
 * paper) using the orthographic heuristic (4.1.1), the collocation heuristic
 * (4.1.2) and the frequent-sentence-starter heuristic (4.1.3).
 */
export class TokenBasedAnnotation implements Annotation {
	constructor(
		private readonly storage: Storage,
		private readonly word: WordTokenizer,
		private readonly ortho: OrthoContext,
	) {}

	annotate(tokens: PunktToken[]): PunktToken[] {
		for (const [one, two] of groupTokens(tokens)) this.tokenAnnotation(one, two);
		return tokens;
	}

	private tokenAnnotation(tokOne: PunktToken, tokTwo: PunktToken | null): void {
		if (tokTwo === null) return;
		if (!this.word.hasPeriodFinal(tokOne)) return;

		const typ = this.word.typeNoPeriod(tokOne);
		const nextTyp = this.word.typeNoSentPeriod(tokTwo);
		const tokIsInitial = this.word.isInitial(tokOne);

		// [4.1.2. Collocation Heuristic] If there is a collocation between the
		// word before and after the period, label tok as an abbreviation and
		// NOT a sentence break. Collocations whose second word is a frequent
		// sentence starter are excluded during training.
		if (this.storage.collocation(`${typ},${nextTyp}`) !== 0) {
			tokOne.sentBreak = false;
			tokOne.abbr = true;
			return;
		}

		// [4.2. PunktToken-Based Reclassification of Abbreviations] If the token is
		// an abbreviation or an ellipsis, decide whether it is *also* a
		// sentence break.
		if ((tokOne.abbr || this.word.isEllipsis(tokOne)) && !tokIsInitial) {
			// [4.1.1. Orthographic Heuristic]
			if (this.ortho.heuristic(tokTwo) === 1) {
				tokOne.sentBreak = true;
				return;
			}

			// [4.1.3. Frequent Sentence Starter Heuristic]
			if (this.word.firstUpper(tokTwo) && this.storage.sentStarter(nextTyp) !== 0) {
				tokOne.sentBreak = true;
				return;
			}
		}

		// Two consecutive lone periods are probably a spaced ellipsis
		// ". . .", so neither is a break.
		if (tokOne.tok === "." && tokTwo.tok === ".") {
			tokOne.sentBreak = false;
			tokTwo.sentBreak = false;
			return;
		}

		// [4.3. PunktToken-Based Detection of Initials and Ordinals] Reclassify
		// initials and ordinals marked as breaks.
		if (tokIsInitial || typ === "##number##") {
			const isSentStarter = this.ortho.heuristic(tokTwo);

			if (isSentStarter === 0) {
				tokOne.sentBreak = false;
				tokOne.abbr = true;
				return;
			}

			// Special heuristic for initials: if the orthographic heuristic is
			// unknown and the next word is always capitalized, mark it an
			// abbreviation (e.g. J. Bach).
			if (
				isSentStarter === -1 &&
				tokIsInitial &&
				this.word.firstUpper(tokTwo) &&
				(this.storage.ortho(nextTyp) & ORTHO_LC) === 0
			) {
				tokOne.sentBreak = false;
				tokOne.abbr = true;
			}
		}
	}
}

/** Decides whether a token is the first in a sentence. */
export class OrthoContext {
	constructor(
		private readonly storage: Storage,
		private readonly punctStrings: PunctStrings,
		private readonly word: WordTokenizer,
	) {}

	/** 1 when the token starts a sentence, 0 when it does not, -1 for unknown. */
	heuristic(token: PunktToken | null): number {
		if (token === null) return 0;

		for (const punct of this.punctStrings.punctuation()) {
			if (token.tok === punct) return 0;
		}

		const orthoCtx = this.storage.ortho(this.word.typeNoSentPeriod(token));

		// If the word is capitalized, occurs at least once with a lower-case
		// first letter, and never occurs with an upper-case first letter
		// sentence-internally, then it is a sentence starter.
		if (
			this.word.firstUpper(token) &&
			(orthoCtx & ORTHO_LC) > 0 &&
			(orthoCtx & ORTHO_MID_UC) === 0
		) {
			return 1;
		}

		// If the word is lower case, and either we have seen it used with upper
		// case or we have never seen it sentence-initially with lower case,
		// then it is not a sentence starter.
		if (
			this.word.firstLower(token) &&
			((orthoCtx & ORTHO_UC) > 0 || (orthoCtx & ORTHO_BEG_LC) === 0)
		) {
			return 0;
		}

		return -1;
	}
}

/** One sentence as the Punkt tokenizer reports it, with both ends. */
export interface RawSentence {
	start: number;
	end: number;
	text: string;
}

/**
 * The sentence tokenizer: word-tokenize, annotate, then cut at each break.
 */
export class SentenceTokenizer {
	constructor(
		readonly storage: Storage,
		readonly word: WordTokenizer,
		readonly annotations: readonly Annotation[],
	) {}

	/**
	 * The fully annotated word tokens.
	 *
	 * Only the tokens around sentence-ending punctuation are produced -- the
	 * word before and after it -- since that is all the annotators read.
	 */
	annotatedTokens(text: string): PunktToken[] {
		const tokens = this.word.tokenize(text, true);
		if (tokens.length === 0) return [];

		let out = tokens;
		for (const ann of this.annotations) out = ann.annotate(out);
		return out;
	}

	/** Splits text into sentences. */
	tokenize(text: string): RawSentence[] {
		const annotated = this.annotatedTokens(text);

		let lastBreak = 0;
		const sentences: RawSentence[] = [];
		for (const token of annotated) {
			if (!token.sentBreak) continue;
			sentences.push({
				start: lastBreak,
				end: token.position,
				text: text.slice(lastBreak, token.position),
			});
			lastBreak = token.position;
		}

		if (lastBreak !== text.length) {
			sentences.push({
				start: lastBreak,
				end: text.length,
				text: text.slice(lastBreak),
			});
		}

		return sentences;
	}
}

/** The default two-pass annotation set, as upstream's `NewAnnotations` builds it. */
export function newAnnotations(
	storage: Storage,
	word: WordTokenizer,
): Annotation[] {
	const punct = word.punctStrings;
	return [
		new TypeBasedAnnotation(storage, word),
		new TokenBasedAnnotation(storage, word, new OrthoContext(storage, punct, word)),
	];
}
