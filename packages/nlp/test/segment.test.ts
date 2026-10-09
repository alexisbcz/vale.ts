import { describe, expect, test } from "bun:test";
import { punktModel } from "@vale-ts/models";
import {
	ProseWordTokenizer,
	PunctStrings,
	type PunktToken,
	Segmenter,
	Storage,
	segment,
	segmenter,
	segmentText,
	sentenceEnd,
	sentenceIn,
	supervisedAbbrevs,
	trimRange,
} from "../src/segment/index.ts";
import { corpus, type GoldenRule, json, rawTexts } from "./fixtures.ts";

describe("Segmenter", () => {
	test("splits on the obvious boundaries", () => {
		expect(segmentText("Hello World. My name is Jonas.")).toEqual([
			"Hello World.",
			"My name is Jonas.",
		]);
		expect(segmentText("There it is! I found it.")).toEqual([
			"There it is!",
			"I found it.",
		]);
		expect(segmentText("What is your name? My name is Jonas.")).toEqual([
			"What is your name?",
			"My name is Jonas.",
		]);
	});

	test("keeps a trained abbreviation with its sentence", () => {
		expect(
			segmentText("Dr. Smith went to Washington. He arrived on Jan. 5."),
		).toEqual(["Dr. Smith went to Washington.", "He arrived on Jan. 5."]);
	});

	test("keeps the abbreviations prose adds by hand", () => {
		// `sgt`, `gov`, `no` and `mt` are missing from the trained model, so
		// without `supervisedAbbrevs` each of these would split in two.
		expect(supervisedAbbrevs).toEqual(["sgt", "gov", "no", "mt"]);
		expect(segmentText("I can see Mt. Fuji from here.")).toEqual([
			"I can see Mt. Fuji from here.",
		]);
	});

	test("reads an unlisted multi-period abbreviation as one", () => {
		// This is what `MultiPunctWordAnnotation` is for: `F.B.I.` is not in
		// the trained model at all.
		expect(segmentText("The F.B.I. investigated. Nothing came of it.")).toEqual([
			"The F.B.I. investigated.",
			"Nothing came of it.",
		]);
	});

	test("does not read a company's exclamation mark as a boundary", () => {
		expect(segmentText("Yahoo! is a company. So is Google.")).toEqual([
			"Yahoo! is a company.",
			"So is Google.",
		]);
	});

	test("drops whitespace-only sentences", () => {
		expect(segmentText("")).toEqual([]);
		expect(segmentText("   ")).toEqual([]);
		expect(segmentText("\n\n\n")).toEqual([]);
	});

	describe("offsets", () => {
		test("locate their text", () => {
			const cases = [
				"",
				"   ",
				"One sentence.",
				"One. Two. Three.",
				"  Leading space. And another.  ",
				"Dr. Smith went to Washington. He arrived on Jan. 5.",
				"She said “hello there.” Then she left.",
				"An ellipsis... and then more. Really.",
				"The F.B.I. investigated. Nothing came of it.",
				"Multi\nline\ntext. With a break.\n\nNew paragraph here.",
				"Unicode: naïve café résumé. Ünïcödé wörds!",
				"Emoji \u{1f389} sentence. Another \u{1f600} one.",
				"Yahoo! is a company. So is Google.",
				"Repeated. Repeated. Repeated.",
			];
			for (const src of cases) {
				for (const s of segment(src)) {
					expect(sentenceIn(src, s)).toBe(s.text);
					expect(s.start).toBeGreaterThanOrEqual(0);
					expect(sentenceEnd(s)).toBeLessThanOrEqual(src.length);
					expect(s.text).toBe(s.text.trim());
				}
			}
		});

		test("are ordered and disjoint over a repeated sentence", () => {
			// What breaks if the offsets are recovered by searching for the
			// sentence's text instead of tracked.
			const src = "Repeated sentence. Something else. Repeated sentence. Done.";
			let prev = -1;
			for (const s of segment(src)) {
				expect(s.start).toBeGreaterThanOrEqual(prev);
				expect(sentenceIn(src, s)).toBe(s.text);
				prev = sentenceEnd(s);
			}
		});

		test("hold over the corpus", () => {
			let checked = 0;
			for (const src of [...corpus(), ...rawTexts()]) {
				for (const s of segment(src)) {
					checked++;
					expect(sentenceIn(src, s)).toBe(s.text);
					expect(s.text).toBe(s.text.trim());
				}
			}
			expect(checked).toBeGreaterThan(200);
		});
	});

	test("two segmenters share one trained model", () => {
		const a = segmenter();
		const b = segmenter();
		expect(a).toBe(b);

		// A segmenter built over its own storage must agree with the shared one.
		const own = new Segmenter(storageWithAbbrevs());
		const src = "Dr. Smith went to Washington. He arrived on Jan. 5.";
		expect(own.segmentText(src)).toEqual(a.segmentText(src));
	});
});

describe("golden rules", () => {
	/**
	 * The standard Punkt accuracy suite.
	 *
	 * prose does not pass all of it and neither does this port, so the
	 * assertion is a rate rather than a per-case equality. 34 of the 40 cases
	 * pass, measured here; six do not, and two of those (the "errant newline"
	 * cases) cannot, because their expected output *rewrites* the input by
	 * joining lines and a sentence here is always a substring of its source.
	 *
	 * The number is the floor, not a target: a change that raises it should
	 * raise the constant too, and a change that lowers it is a regression.
	 */
	const PASS_RATE = 34 / 40;

	test("pass at the rate prose achieves", () => {
		const rules = json<GoldenRule[]>("golden_rules_en.json");
		let passed = 0;
		const failures: string[] = [];
		for (const rule of rules) {
			if (JSON.stringify(segmentText(rule.input)) === JSON.stringify(rule.output))
				passed++;
			else failures.push(rule.name);
		}
		expect(passed / rules.length).toBeGreaterThanOrEqual(PASS_RATE);
		// Named so that a future change shows which cases moved.
		expect(failures.length).toBe(rules.length - 34);
	});
});

describe("trimRange", () => {
	test("narrows past whitespace without losing where it was", () => {
		const text = "  hello  ";
		expect(trimRange(text, 0, text.length)).toEqual([2, 7]);
		expect(text.slice(2, 7)).toBe("hello");
	});

	test("clamps a range that falls outside the text", () => {
		expect(trimRange("abc", -5, 99)).toEqual([0, 3]);
	});

	test("collapses an all-whitespace range", () => {
		const [lo, hi] = trimRange("   ", 0, 3);
		expect(lo).toBe(hi);
	});

	test("steps over an astral character whole", () => {
		const text = " \u{1f389} ";
		expect(trimRange(text, 0, text.length)).toEqual([1, 3]);
	});
});

describe("the punkt word tokenizer", () => {
	const word = new ProseWordTokenizer(new PunctStrings());

	const tok = (s: string): PunktToken => {
		const toks = word.tokenize(s, false);
		return toks[toks.length - 1]!;
	};

	test("normalizes a number to one type", () => {
		expect(word.type(tok("1,234.5"))).toBe("##number##");
		expect(word.type(tok("Hello"))).toBe("hello");
	});

	test("strips the final period only when it ends a sentence", () => {
		const t = tok("mr.");
		expect(word.typeNoPeriod(t)).toBe("mr");
		expect(word.typeNoSentPeriod(t)).toBe("mr.");
		t.sentBreak = true;
		expect(word.typeNoSentPeriod(t)).toBe("mr");
	});

	test("reads the case of the first character", () => {
		expect(word.firstUpper(tok("Hello"))).toBe(true);
		expect(word.firstLower(tok("Hello"))).toBe(false);
		expect(word.firstUpper(tok("école"))).toBe(false);
		expect(word.firstLower(tok("école"))).toBe(true);
	});

	test("classifies initials, ellipses and alphabetic words", () => {
		expect(word.isInitial(tok("J."))).toBe(true);
		expect(word.isInitial(tok("Jo."))).toBe(false);
		expect(word.isEllipsis(tok("end.."))).toBe(true);
		expect(word.isAlpha(tok("word"))).toBe(true);
		expect(word.isAlpha(tok("word1"))).toBe(false);
	});

	test("excludes the sentence enders prose removed", () => {
		// Upstream lists `.'`; prose does not, so a quoted contraction does not
		// end a sentence on its own.
		expect(word.hasSentEndChars(tok("done.'"))).toBe(false);
		expect(word.hasSentEndChars(tok('done."'))).toBe(true);
		expect(word.hasSentEndChars(tok("Yahoo!"))).toBe(false);
	});

	test("reports each word's end position", () => {
		const src = "One two three.";
		for (const t of word.tokenize(src, false)) {
			expect(src.slice(t.position - t.tok.length, t.position)).toBe(t.tok);
		}
	});
});

/** The shared trained model, as `segment/index.ts` prepares it. */
function storageWithAbbrevs(): Storage {
	const storage = new Storage(punktModel());
	for (const abbr of supervisedAbbrevs) storage.addAbbrev(abbr);
	return storage;
}
