/**
 * The numbers a `metric` or `readability` rule measures.
 *
 * Two kinds go in. Counts come from the reader -- how many headings a document
 * has, how many list items, how many tables -- and text statistics come from
 * the summarizer: words, sentences, syllables and the readability scores built
 * on them.
 */

import { quotedWords, type Document as SummaryDocument } from "@vale-ts/nlp";

/** The measurements a rule can read, by name. */
export type Metrics = Record<string, number>;

/**
 * One block's measurements: the document statistics plus the elements it
 * holds.
 *
 * Empty when the text has no words, so that a rule measuring an empty block
 * reports nothing rather than dividing by zero.
 */
export function blockMetrics(
	doc: SummaryDocument,
	counts: Readonly<Metrics>,
): Metrics {
	const params: Metrics = {};
	if (doc.numWords === 0) return params;

	for (const [k, v] of Object.entries(counts)) {
		// A table's own counts are reported per table rather than per block.
		if (k.startsWith("table")) continue;
		params[k.replaceAll(".", "_")] = v;
	}

	addTextMetrics(params, doc);
	return params;
}

function addTextMetrics(params: Metrics, doc: SummaryDocument): void {
	params.complex_words = doc.numComplexWords;
	params.long_words = doc.numLongWords;
	params.sentences = doc.numSentences;
	params.characters = doc.numCharacters;
	params.words = doc.numWords;
	params.polysyllabic_words = doc.numPolysylWords;
	params.syllables = doc.numSyllables;
	params.quote_words = quotedWords(doc.content);
	params.sentence_length_sd = sentenceLengthSD(doc);

	// Every score divides by the sentence count, and a block with words but no
	// sentence would put a NaN in the output.
	if (doc.numSentences === 0) return;

	params.automated_readability = doc.automatedReadability();
	params.coleman_liau = doc.colemanLiau();
	params.dale_chall = doc.daleChall();
	params.flesch_kincaid = doc.fleschKincaid();
	params.flesch_reading_ease = doc.fleschReadingEase();
	params.gunning_fog = doc.gunningFog();
	params.lix = doc.lix();
	params.smog = doc.smog();
}

/**
 * The standard deviation of the words per sentence: how much the sentences
 * vary in length.
 *
 * A document of one long sentence after another and a document of short ones
 * both come out at zero, which is the point -- it measures variety, not size.
 */
export function sentenceLengthSD(doc: SummaryDocument): number {
	const n = doc.sentences.length;
	if (n === 0) return 0;

	let mean = 0;
	for (const s of doc.sentences) mean += s.length;
	mean /= n;

	let sum = 0;
	for (const s of doc.sentences) {
		const d = s.length - mean;
		sum += d * d;
	}
	return Math.sqrt(sum / n);
}
