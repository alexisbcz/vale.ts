/**
 * prose's Punkt customizations: a word tokenizer with a stricter idea of
 * sentence-ending punctuation, an extra annotation pass for abbreviations the
 * training data never saw, and four abbreviations supplied by hand.
 *
 * These exist because the shipped English model was trained on newswire and
 * mis-segments the text Vale actually lints: `F.B.I.` is not in the model,
 * `Yahoo!` is not a sentence, and an ellipsis mid-sentence is not a break.
 */

import type {
	Annotation,
	OrthoContext,
	PunctStrings,
	PunktToken,
	Storage,
} from "./sentences.ts";
import { groupTokens, ORTHO_LC, WordTokenizer } from "./sentences.ts";

const reAbbr = /(?:\w\.)+\w*\./;
const reLooksLikeEllipsis = /(?:\.\s?){2,}\./;
const reEntities = /Yahoo!/;

/** The abbreviations the model is missing, added to the shared storage. */
export const supervisedAbbrevs: readonly string[] = ["sgt", "gov", "no", "mt"];

/**
 * prose's word tokenizer, which differs from upstream's only in which
 * punctuation it reads as closing a sentence.
 */
export class ProseWordTokenizer extends WordTokenizer {
	constructor(punctStrings: PunctStrings) {
		super(punctStrings);
	}

	/**
	 * Whether the token ends in punctuation that closes a sentence.
	 *
	 * Narrower than upstream -- `.'` is absent, so `don't` inside a quotation
	 * does not end one -- and a company whose name ends in `!` is excluded
	 * outright.
	 */
	override hasSentEndChars(t: PunktToken): boolean {
		const enders = [
			'."',
			".)",
			".’",
			".”",
			"?",
			'?"',
			"?'",
			"?)",
			"?’",
			"?”",
			"!",
			'!"',
			"!'",
			"!)",
			"!’",
			"!”",
		];

		for (const ender of enders) {
			if (t.tok.endsWith(ender) && !reEntities.test(t.tok)) return true;
		}

		const parens = [".[", ".(", '."', "?[", "?(", "![", "!("];
		for (const paren of parens) {
			if (t.tok.includes(paren)) return true;
		}

		return false;
	}
}

/**
 * The third annotation pass, which teases out abbreviations such as `F.B.I.`
 * that the trained model does not list.
 */
export class MultiPunctWordAnnotation implements Annotation {
	constructor(
		private readonly storage: Storage,
		private readonly word: ProseWordTokenizer,
		private readonly ortho: OrthoContext,
	) {}

	annotate(tokens: PunktToken[]): PunktToken[] {
		for (const [one, two] of groupTokens(tokens)) {
			if (two === null) {
				const tok = one.tok;
				if (tok.includes("\n") && tok.includes(" ")) {
					// Mislabeled because of an errant newline.
					one.sentBreak = false;
				}
				continue;
			}

			this.tokenAnnotation(one, two);
		}

		return tokens;
	}

	private tokenAnnotation(tokOne: PunktToken, tokTwo: PunktToken): void {
		// This is an expensive calculation, so it happens only once.
		let nextTyp = "";

		// Two periods in a row are probably an ellipsis the word tokenizer did
		// not split properly.
		if (tokOne.tok.endsWith(".") && tokTwo.tok === ".") {
			tokOne.sentBreak = false;
			tokTwo.sentBreak = false;
			return;
		}

		const isNonBreak = tokOne.tok.endsWith(".") && !tokOne.sentBreak;
		const isEllipsis = reLooksLikeEllipsis.test(tokOne.tok);
		const isInternal = tokOne.sentBreak && looksInternal(tokOne.tok);

		if (isNonBreak || isEllipsis || isInternal) {
			nextTyp = this.word.typeNoSentPeriod(tokTwo);
			const isStarter = this.storage.sentStarter(nextTyp);

			// An ellipsis followed by a capitalized word or a frequent sentence
			// starter does break the sentence.
			if (isEllipsis) {
				if (this.word.firstUpper(tokTwo) || isStarter !== 0) {
					tokOne.sentBreak = true;
					return;
				}
			}

			// Punctuation that could occur sentence-internally only breaks when
			// the following word is capitalized or a frequent starter.
			if (isInternal) {
				if (this.word.firstLower(tokTwo) && isStarter === 0) {
					tokOne.sentBreak = false;
					return;
				}
			}

			// A period not marked as a break becomes one when the next word is
			// capitalized and is also seen lower-cased elsewhere.
			if (isNonBreak && this.word.firstUpper(tokTwo)) {
				if ((this.storage.ortho(nextTyp) & ORTHO_LC) !== 0) {
					tokOne.sentBreak = true;
				}
			}
		}

		if (!reAbbr.test(tokOne.tok)) return;
		if (this.word.isInitial(tokOne)) return;

		tokOne.abbr = true;
		tokOne.sentBreak = false;

		// [4.1.1. Orthographic Heuristic] Is there orthographic evidence about
		// whether the next word starts a sentence?
		if (this.ortho.heuristic(tokTwo) === 1) {
			tokOne.sentBreak = true;
			return;
		}

		if (nextTyp === "") nextTyp = this.word.typeNoSentPeriod(tokTwo);

		// [4.1.3. Frequent Sentence Starter Heuristic] If the next word is
		// capitalized and is a frequent sentence starter, this is a break.
		if (this.word.firstUpper(tokTwo) && this.storage.sentStarter(nextTyp) !== 0) {
			tokOne.sentBreak = true;
		}
	}
}

/**
 * Whether the token's punctuation could appear sentence-internally -- that is,
 * a parenthesis or a quotation mark.
 */
function looksInternal(tok: string): boolean {
	const internal = [")", "’", "”", '"', "'"];
	for (const punc of internal) {
		if (tok.endsWith(punc)) return true;
	}
	return false;
}
