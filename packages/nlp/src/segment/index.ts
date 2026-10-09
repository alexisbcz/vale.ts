/**
 * Splitting text into sentences that know where they came from.
 *
 * Segmentation uses the Punkt algorithm (`sentences.ts`) with prose's
 * customizations for English (`punkt.ts`). The trained model is immutable once
 * built, so it is loaded once per process and shared; sentences carry their
 * offsets, so a caller never has to go looking for where one started -- which
 * would be both slow and wrong for a repeated sentence.
 */

import { punktModel } from "@vale-ts/models";
import { decodeLastRune, decodeRune, runeIsSpace } from "../util.ts";
import {
	MultiPunctWordAnnotation,
	ProseWordTokenizer,
	supervisedAbbrevs,
} from "./punkt.ts";
import type { Annotation } from "./sentences.ts";
import {
	newAnnotations,
	OrthoContext,
	PunctStrings,
	SentenceTokenizer,
	Storage,
} from "./sentences.ts";

export * from "./punkt.ts";
export * from "./sentences.ts";

/**
 * A segmented span of text and its position in the source.
 *
 * The same invariant tokens have holds here:
 *
 *     src.slice(s.start, s.start + s.text.length) === s.text
 *
 * Leading and trailing whitespace is trimmed from `text`, and `start` is
 * advanced to match, so the offsets stay accurate rather than merely close.
 */
export interface Sentence {
	/** The sentence, whitespace-trimmed. */
	text: string;
	/** The offset of `text` within the source. */
	start: number;
}

/** Where `s` ends in the source, exclusive. */
export function sentenceEnd(s: Sentence): number {
	return s.start + s.text.length;
}

/** The sentence's text as located in `src`, or `""` if the offsets do not fit. */
export function sentenceIn(src: string, s: Sentence): string {
	if (s.start < 0 || sentenceEnd(s) > src.length) return "";
	return src.slice(s.start, sentenceEnd(s));
}

export class Segmenter {
	private readonly tokenizer: SentenceTokenizer;

	constructor(training: Storage) {
		const lang = new PunctStrings();
		const word = new ProseWordTokenizer(lang);
		const ortho = new OrthoContext(training, lang, word);

		const annotations: Annotation[] = newAnnotations(training, word);
		annotations.push(new MultiPunctWordAnnotation(training, word, ortho));

		this.tokenizer = new SentenceTokenizer(training, word, annotations);
	}

	/**
	 * Splits text into sentences.
	 *
	 * Sentences that are entirely whitespace are dropped rather than returned
	 * as empty spans.
	 */
	segment(text: string): Sentence[] {
		const raw = this.tokenizer.tokenize(text);

		const out: Sentence[] = [];
		for (const r of raw) {
			const [start, end] = trimRange(text, r.start, r.end);
			if (start >= end) continue;
			out.push({ text: text.slice(start, end), start });
		}
		return out;
	}

	/** Just the sentence strings, for callers that do not care where they came from. */
	segmentText(text: string): string[] {
		return this.segment(text).map((s) => s.text);
	}
}

/**
 * Narrows `[start, end)` past surrounding whitespace.
 *
 * Trimming the text with `trimSpace` would produce the same string but throw
 * away how much was trimmed, leaving the reported offset pointing at
 * whitespace the text no longer contains. Trimming the range instead keeps
 * `text.slice(start, end)` equal to the sentence.
 */
export function trimRange(
	text: string,
	start: number,
	end: number,
): [number, number] {
	let lo = start < 0 ? 0 : start;
	let hi = end > text.length ? text.length : end;
	while (lo < hi) {
		const [cp, size] = decodeRune(text, lo);
		if (size === 0 || lo + size > hi || !runeIsSpace(cp)) break;
		lo += size;
	}
	while (hi > lo) {
		const [cp, size] = decodeLastRune(text, hi);
		if (size === 0 || hi - size < lo || !runeIsSpace(cp)) break;
		hi -= size;
	}
	return [lo, hi];
}

let trained: Storage | null = null;

/**
 * The trained English model, prepared exactly once.
 *
 * The supervised abbreviations are added here rather than per-segmenter so the
 * shared storage is already complete and is never written to afterwards.
 */
function trainedStorage(): Storage {
	if (trained === null) {
		const storage = new Storage(punktModel());
		for (const abbr of supervisedAbbrevs) storage.addAbbrev(abbr);
		trained = storage;
	}
	return trained;
}

let shared: Segmenter | null = null;

/**
 * The shared English segmenter, built on first use.
 *
 * The Punkt model costs time and memory to build and most Vale runs never
 * segment anything, so nothing is read until something is.
 */
export function segmenter(): Segmenter {
	if (shared === null) shared = new Segmenter(trainedStorage());
	return shared;
}

/** Splits text into sentences with the shared segmenter. */
export function segment(text: string): Sentence[] {
	return segmenter().segment(text);
}

/** Splits text into sentence strings with the shared segmenter. */
export function segmentText(text: string): string[] {
	return segmenter().segmentText(text);
}
