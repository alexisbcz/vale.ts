import { describe, expect, test } from "bun:test";
import { newDocument } from "../src/summarize/index.ts";
import { mean, round, stdDev } from "../src/summarize/mathutil.ts";
import { syllables } from "../src/summarize/syllables.ts";
import { json, lines } from "./fixtures.ts";

/** One row of prose's `summarize.json`. */
interface SummarizeCase {
	text: string;
	sentences: number;
	words: number;
	characters: number;
	AutomatedReadability: number;
	ColemanLiau: number;
	FleschKincaid: number;
	Gunningfog: number;
	SMOG: number;
	MeanGrade: number;
	StdDevGrade: number;
	DaleChall: number;
	ReadingEase: number;
	LIX: number;
}

/** Scores are published to two decimals, so that is the precision asserted. */
const two = (n: number) => n.toFixed(2);

describe("Document", () => {
	const cases = json<SummarizeCase[]>("summarize.json");

	test("counts what prose counts", () => {
		expect(cases.length).toBeGreaterThan(0);
		for (const c of cases) {
			const d = newDocument(c.text);
			expect(d.numSentences).toBe(c.sentences);
			expect(d.numWords).toBe(c.words);
			expect(d.numCharacters).toBe(c.characters);
		}
	});

	test("scores what prose scores", () => {
		for (const c of cases) {
			const a = newDocument(c.text).assess();
			expect(two(a.automatedReadability)).toBe(two(c.AutomatedReadability));
			expect(two(a.colemanLiau)).toBe(two(c.ColemanLiau));
			expect(two(a.fleschKincaid)).toBe(two(c.FleschKincaid));
			expect(two(a.gunningFog)).toBe(two(c.Gunningfog));
			expect(two(a.smog)).toBe(two(c.SMOG));
			expect(two(a.daleChall)).toBe(two(c.DaleChall));
			expect(two(a.readingEase)).toBe(two(c.ReadingEase));
			expect(two(a.lix)).toBe(two(c.LIX));
			expect(two(a.meanGradeLevel)).toBe(two(c.MeanGrade));
			expect(two(a.stdDevGradeLevel)).toBe(two(c.StdDevGrade));
		}
	});

	test("the per-score methods agree with the assessment", () => {
		const d = newDocument(cases[0]!.text);
		const a = d.assess();
		expect(d.fleschKincaid()).toBe(a.fleschKincaid);
		expect(d.fleschReadingEase()).toBe(a.readingEase);
		expect(d.gunningFog()).toBe(a.gunningFog);
		expect(d.lix()).toBe(a.lix);
		expect(d.smog()).toBe(a.smog);
		expect(d.automatedReadability()).toBe(a.automatedReadability);
		expect(d.colemanLiau()).toBe(a.colemanLiau);
		expect(d.daleChall()).toBe(a.daleChall);
	});

	test("records its sentences, their words and their paragraph", () => {
		const d = newDocument("One two three. Four five.\n\nSix seven eight nine.");
		expect(d.numParagraphs).toBe(2);
		expect(d.sentences.map((s) => s.text)).toEqual([
			"One two three.",
			"Four five.",
			"Six seven eight nine.",
		]);
		expect(d.sentences.map((s) => s.length)).toEqual([3, 2, 4]);
		expect(d.sentences.map((s) => s.paragraph)).toEqual([0, 0, 1]);
		expect(d.sentences[0]!.words.map((w) => w.text)).toEqual([
			"One",
			"two",
			"three",
		]);
		expect(d.numWords).toBe(9);
	});

	test("counts long words in bytes, as LIX does", () => {
		// Six characters is not long; seven is. `résumés` is seven
		// characters but nine bytes, so Go calls it long and so does this.
		expect(newDocument("abcdef.").numLongWords).toBe(0);
		expect(newDocument("abcdefg.").numLongWords).toBe(1);
		expect(newDocument("résumés.").numLongWords).toBe(1);
	});

	test("counts only letters and digits as characters", () => {
		expect(newDocument("a1-b!").numCharacters).toBe(3);
	});

	test("counts polysyllabic and complex words apart", () => {
		// Both words have more than two syllables, but `isComplex` discounts
		// the one `-ed` adds, so `provided` is polysyllabic without being
		// complex -- which is the distinction Gunning fog rests on.
		const d = newDocument("Interesting provided.");
		expect(d.numPolysylWords).toBe(2);
		expect(d.numComplexWords).toBe(1);
	});

	test("word frequency and density", () => {
		const d = newDocument("the cat and the dog.");
		expect(d.wordFrequency.get("the")).toBe(2);
		expect(d.wordDensity().get("the")).toBe(0.4);
		expect(d.meanWordLength()).toBe(round(15 / 5, 3));
		expect(d.meanWordPerSentence()).toBe(5);
	});

	test("keywords drop stop words and fold case", () => {
		const k = newDocument("The Cat and the cat.").keywords();
		expect(k.get("cat")).toBe(2);
		expect(k.has("the")).toBe(false);
		expect(k.has("and")).toBe(false);
	});

	test("the summary takes the highest-ranked paragraphs in document order", () => {
		const text =
			"Nothing here at all.\n\n" +
			"Linters analyze prose. Prose linters analyze prose carefully.\n\n" +
			"Another short one.";
		const top = newDocument(text).summary(2);
		expect(top.length).toBe(2);
		expect(top.map((p) => p.position)).toEqual(
			[...top.map((p) => p.position)].sort(),
		);
		expect(top.some((p) => p.position === 1)).toBe(true);
	});

	test("empty text yields no words", () => {
		const d = newDocument("");
		expect(d.numWords).toBe(0);
		expect(d.numSentences).toBe(0);
		expect(d.numParagraphs).toBe(1);
	});
});

describe("syllables", () => {
	test("matches prose's table word for word", () => {
		const table = json<Record<string, number>>("syllables.json");
		const words = Object.keys(table);
		expect(words.length).toBeGreaterThan(4000);
		for (const word of words) {
			expect(syllables(word)).toBe(table[word]!);
		}
	});

	test("leaves early on short words", () => {
		expect(syllables("")).toBe(0);
		expect(syllables("a")).toBe(1);
		expect(syllables("an")).toBe(1);
	});

	test("knows its corner cases, whatever the case", () => {
		expect(syllables("people")).toBe(2);
		expect(syllables("People")).toBe(2);
		expect(syllables("apostrophe")).toBe(4);
	});

	test("is as accurate as prose on the graded word lists", () => {
		// 8,798 of the same 9,462 words `summarize/syllables_test.go` grades,
		// which is 92.98%. The Go test claims a 93% floor but rounds the ratio
		// to zero decimals before comparing, so it really asserts 50%; the
		// measured figure is pinned here instead.
		let right = 0;
		let total = 0;
		for (const n of [1, 2, 3, 4, 5, 6, 7]) {
			for (const word of lines(`${n}-syllable-words.txt`)) {
				total++;
				if (syllables(word) === n) right++;
			}
		}
		expect(total).toBe(9462);
		expect(right).toBe(8798);
	});
});

describe("mathutil", () => {
	test("mean and standard deviation", () => {
		expect(mean([1, 2, 3])).toBe(2);
		expect(stdDev([2, 2, 2])).toBe(0);
		expect(stdDev([1, 3])).toBe(1);
	});

	test("an empty sample is NaN, not zero", () => {
		expect(mean([])).toBeNaN();
		expect(stdDev([])).toBeNaN();
	});

	test("round sends halves away from zero in both directions", () => {
		// `Math.round` would give -1.2 for the second: it rounds half *up*,
		// which is not symmetric, and that is why this is written out.
		expect(round(1.25, 1)).toBe(1.3);
		expect(round(-1.25, 1)).toBe(-1.3);
		expect(round(2.4999, 0)).toBe(2);
		expect(round(Number.NaN, 2)).toBeNaN();
	});
});
