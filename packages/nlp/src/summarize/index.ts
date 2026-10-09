/**
 * Readability scores, usage statistics and TL;DR summaries.
 *
 * A `Document` counts a text once -- sentences, words, characters, syllables --
 * and every score is then arithmetic over those counts. Vale exposes the counts
 * and the scores as block metrics, so a rule can require, say, a Flesch reading
 * ease above 50.
 */

import { segmenter } from "../segment/index.ts";
import { endsWithAny, isLetter, isNumber, trimSpace, utf8Len } from "../util.ts";
import { newWordBoundaryTokenizer, type RegexpTokenizer } from "../words.ts";
import { easyWords } from "./easy.ts";
import { mean, round, stdDev } from "./mathutil.ts";
import { stopWords } from "./stop.ts";
import { syllables } from "./syllables.ts";

export { easyWords } from "./easy.ts";
export * from "./mathutil.ts";
export { stopWords } from "./stop.ts";
export * from "./syllables.ts";

let words: RegexpTokenizer | null = null;

/** The word tokenizer, built on first use. */
function wordTokenizer(): RegexpTokenizer {
	if (words === null) words = newWordBoundaryTokenizer();
	return words;
}

/** A single word in a document. */
export interface Word {
	/** The text as it appeared. */
	text: string;
	/** How many syllables it has. */
	syllables: number;
}

/** A single sentence in a document. */
export interface Sentence {
	/** The text as it appeared, whitespace-trimmed. */
	text: string;
	/** How many words it holds. */
	length: number;
	/** The words it holds. */
	words: Word[];
	/** Which paragraph it belongs to, zero-based. */
	paragraph: number;
}

/** A paragraph ranked by its number of keywords. */
export interface RankedParagraph {
	sentences: Sentence[];
	/** The zero-based position within the document. */
	position: number;
	rank: number;
}

/** Every metric a document carries, in one object. */
export interface Assessment {
	// Assessments returning an estimated grade level.
	automatedReadability: number;
	colemanLiau: number;
	fleschKincaid: number;
	gunningFog: number;
	smog: number;
	lix: number;

	/** The mean of the grade levels above. */
	meanGradeLevel: number;
	/** Their standard deviation. */
	stdDevGradeLevel: number;

	// Assessments returning non-grade numerical scores.
	daleChall: number;
	readingEase: number;
}

/**
 * A collection of text to be analyzed.
 *
 * Constructing one segments and tokenizes the text and counts everything the
 * scores need; the scores themselves are then free.
 */
export class Document {
	/** The text as given. */
	readonly content: string;

	/** The number of characters -- letters and digits only. */
	numCharacters = 0;
	/** Polysyllabic words, less those that get there through a common suffix. */
	numComplexWords = 0;
	/** The number of paragraphs. */
	numParagraphs = 0;
	/** Words with more than two syllables. */
	numPolysylWords = 0;
	/** The number of sentences. */
	numSentences = 0;
	/** The number of syllables. */
	numSyllables = 0;
	/** The number of words. */
	numWords = 0;
	/** Words longer than six bytes, which is what LIX calls long. */
	numLongWords = 0;
	/** The document's sentences. */
	sentences: Sentence[] = [];
	/** How often each word occurs, by the word as written. */
	wordFrequency = new Map<string, number>();

	constructor(text: string) {
		this.content = text;
		this.initialize();
	}

	/** Counts everything the readability and usage statistics need. */
	private initialize(): void {
		const paragraphs = this.content.split("\n\n");
		for (let i = 0; i < paragraphs.length; i++) {
			for (const s of segmenter().segmentText(paragraphs[i]!)) {
				const wordCount = this.numWords;
				this.numSentences++;
				const words: Word[] = [];
				for (const raw of wordTokenizer().tokenize(s)) {
					const word = trimSpace(raw);
					if (word.length === 0) continue;
					this.numCharacters += countChars(word);
					this.wordFrequency.set(word, (this.wordFrequency.get(word) ?? 0) + 1);
					if (utf8Len(word) > 6) this.numLongWords++;
					const syl = syllables(word);
					words.push({ text: word, syllables: syl });
					this.numSyllables += syl;
					if (syl > 2) this.numPolysylWords++;
					if (isComplex(word, syl)) this.numComplexWords++;
					this.numWords++;
				}
				this.sentences.push({
					text: trimSpace(s),
					length: this.numWords - wordCount,
					words,
					paragraph: i,
				});
			}
			this.numParagraphs++;
		}
	}

	/** The Flesch-Kincaid grade level. */
	fleschKincaid(): number {
		const x = (0.39 * this.numWords) / this.numSentences;
		const y = (11.8 * this.numSyllables) / this.numWords;
		return x + y - 15.59;
	}

	/** The Flesch reading-ease score. */
	fleschReadingEase(): number {
		const x = (1.015 * this.numWords) / this.numSentences;
		const y = (84.6 * this.numSyllables) / this.numWords;
		return 206.835 - x - y;
	}

	/** The Gunning fog index. */
	gunningFog(): number {
		const x = this.numWords / this.numSentences;
		const y = this.numComplexWords / this.numWords;
		return 0.4 * (x + 100.0 * y);
	}

	/** The LIX readability measure. */
	lix(): number {
		return (
			this.numWords / this.numSentences + (this.numLongWords * 100) / this.numWords
		);
	}

	/** The SMOG grade. */
	smog(): number {
		return (
			1.043 * Math.sqrt((this.numPolysylWords * 30.0) / this.numSentences) + 3.1291
		);
	}

	/** The automated readability index. */
	automatedReadability(): number {
		const x = 4.71 * (this.numCharacters / this.numWords);
		const y = 0.5 * (this.numWords / this.numSentences);
		return x + y - 21.43;
	}

	/** The Coleman-Liau index. */
	colemanLiau(): number {
		const x = 0.0588 * (this.numCharacters / this.numWords) * 100;
		const y = 0.296 * (this.numSentences / this.numWords) * 100;
		return x - y - 15.8;
	}

	/**
	 * The Dale-Chall score.
	 *
	 * Note that the easy words are counted once each rather than once per
	 * occurrence -- the loop is over the frequency table's keys, not its
	 * totals. That is what the Go implementation does, and the published
	 * reference scores were produced with it, so it is kept.
	 */
	daleChall(): number {
		let easy = 0;
		for (const word of this.wordFrequency.keys()) {
			if (easyWords.has(word)) easy++;
		}
		const hard = this.numWords - easy;
		const x = (hard / this.numWords) * 100;
		const y = this.numWords / this.numSentences;
		return 0.1579 * x + 0.0496 * y;
	}

	/** Every score at once, plus the mean and spread of the grade levels. */
	assess(): Assessment {
		const a: Assessment = {
			fleschKincaid: this.fleschKincaid(),
			readingEase: this.fleschReadingEase(),
			gunningFog: this.gunningFog(),
			smog: this.smog(),
			daleChall: this.daleChall(),
			automatedReadability: this.automatedReadability(),
			colemanLiau: this.colemanLiau(),
			lix: this.lix(),
			meanGradeLevel: 0,
			stdDevGradeLevel: 0,
		};

		const gradeScores = [
			a.fleschKincaid,
			a.automatedReadability,
			a.gunningFog,
			a.smog,
			a.colemanLiau,
		];

		const m = mean(gradeScores);
		const sd = stdDev(gradeScores);
		if (!Number.isNaN(m) && !Number.isNaN(sd)) {
			a.meanGradeLevel = m;
			a.stdDevGradeLevel = sd;
		}

		return a;
	}

	/** The document's `n` highest-ranked paragraphs, by keyword frequency. */
	summary(n: number): RankedParagraph[] {
		const rankings: RankedParagraph[] = [];
		const scores = this.keywords();
		for (let i = 0; i < this.numParagraphs; i++) {
			const p: RankedParagraph = { sentences: [], position: i, rank: 0 };
			let rank = 0;
			let size = 0;
			for (const s of this.sentences) {
				if (s.paragraph !== i) continue;
				size += s.length;
				for (const w of s.words) {
					const score = scores.get(w.text);
					if (score !== undefined) rank += score;
				}
				p.sentences.push(s);
			}
			// Favor longer paragraphs, as they tend to be more informational.
			p.rank = rank * size;
			rankings.push(p);
		}

		// Sort by ranking, keeping equal ranks in document order so that the
		// cut below is deterministic -- Go's sort.Sort is not stable, so a tie
		// there can go either way.
		const byRank = rankings
			.map((p, i) => ({ p, i }))
			.sort((a, b) => a.p.rank - b.p.rank || a.i - b.i)
			.map((e) => e.p);

		// Take the top-n paragraphs, then put them back in document order.
		const top = byRank.length > n ? byRank.slice(byRank.length - n) : byRank;
		return [...top].sort((a, b) => a.position - b.position);
	}

	/** Each word and its share of the document, to three decimals. */
	wordDensity(): Map<string, number> {
		const density = new Map<string, number>();
		for (const [word, freq] of this.wordFrequency) {
			density.set(word, round(freq / this.numWords, 3));
		}
		return density;
	}

	/** The document's words as `word -> count`, less stop words and case. */
	keywords(): Map<string, number> {
		const scores = new Map<string, number>();
		for (const [word, freq] of this.wordFrequency) {
			const normalized = word.toLowerCase();
			if (stopWords.has(normalized)) continue;
			scores.set(normalized, (scores.get(normalized) ?? 0) + freq);
		}
		return scores;
	}

	/** The mean number of characters per word, to three decimals. */
	meanWordLength(): number {
		return round(this.numCharacters / this.numWords, 3);
	}

	/**
	 * The mean number of words per sentence.
	 *
	 * prose has no such method -- this is the quantity every grade-level score
	 * is built on, written out for callers that want it on its own. Nothing in
	 * Vale depends on it, so it is unrounded.
	 */
	meanWordPerSentence(): number {
		return this.numWords / this.numSentences;
	}
}

/** Counts a text's words, sentences and syllables and returns the document. */
export function newDocument(text: string): Document {
	return new Document(text);
}

/**
 * Whether a word is complex: more than two syllables, not counting the one a
 * common inflection adds.
 */
function isComplex(word: string, syl: number): boolean {
	let n = syl;
	if (endsWithAny(word, ["es", "ed", "ing"])) n--;
	return n > 2;
}

/** How many of `word`'s characters are letters or digits. */
function countChars(word: string): number {
	let n = 0;
	for (const c of word) {
		if (isLetter(c) || isNumber(c)) n++;
	}
	return n;
}
