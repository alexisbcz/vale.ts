import { describe, expect, test } from "bun:test";
import {
	newBlanklineTokenizer,
	newWordBoundaryTokenizer,
	newWordPunctTokenizer,
	proseTokenizer,
	Tokenizer,
	TreebankWordTokenizer,
	tokenEnd,
	tokenIn,
} from "../src/words.ts";
import { corpus, json } from "./fixtures.ts";

describe("Tokenizer", () => {
	const tk = proseTokenizer();

	test("pins the splitting rules", () => {
		const cases: Array<[string, string[]]> = [
			[
				"They'll save and invest more.",
				["They", "'ll", "save", "and", "invest", "more", "."],
			],
			["Don't stop.", ["Do", "n't", "stop", "."]],
			["$100 well spent.", ["$", "100", "well", "spent", "."]],
			["Well) done", ["Well", ")", "done"]],
			["He said “hi” now.", ["He", "said", "“", "hi", "”", "now", "."]],
			["It’s fine.", ["It", "’s", "fine", "."]],
		];
		for (const [input, want] of cases) {
			expect(tk.tokenize(input).map((t) => t.text)).toEqual(want);
		}
	});

	test("offsets locate their text", () => {
		// Deliberately full of multi-byte text: a tokenizer that measured
		// offsets against a sanitized copy would place these wrong while
		// looking right on ASCII.
		const cases = [
			"",
			" ",
			"Hello.",
			'He said "hi there" to me.',
			"He said “hi there” to me.",
			"It&rsquo;s a test of offsets.",
			"It’s a test — with an em dash.",
			"They'll say don't, won't, and I'm.",
			"Dr. Smith went to Washington, D.C. on Jan. 5.",
			"$100 (roughly) [see note] — 50% off!",
			"emoji \u{1f389} and \u{1f600} mixed with ASCII",
			"Ünïcödé wörds with áccents and ñ.",
			"multiple    spaces\tand\ttabs\nand\nnewlines",
			"trailing whitespace   ",
			"   leading whitespace",
			"a",
			"...",
			"(-8 :) 8-D",
			"naïve café résumé",
			"“Nested ‘quotes’ here,” she said.",
			"Repeated repeated repeated words words.",
			"http://example.com/path?q=1 and user@example.com",
		];
		for (const src of cases) {
			for (const tok of tk.tokenize(src)) {
				expect(tokenIn(src, tok)).toBe(tok.text);
				expect(tok.start).toBeGreaterThanOrEqual(0);
				expect(tokenEnd(tok)).toBeLessThanOrEqual(src.length);
			}
		}
	});

	test("offsets are ordered and disjoint", () => {
		const src = "the cat sat on the mat, and then the cat sat again on the mat.";
		let prev = -1;
		for (const tok of tk.tokenize(src)) {
			expect(tok.start).toBeGreaterThanOrEqual(prev);
			expect(tokenIn(src, tok)).toBe(tok.text);
			prev = tokenEnd(tok);
		}
	});

	test("offsets hold over the corpus", () => {
		let checked = 0;
		for (const src of corpus()) {
			for (const tok of tk.tokenize(src)) {
				checked++;
				expect(tokenIn(src, tok)).toBe(tok.text);
			}
		}
		expect(checked).toBeGreaterThan(700);
	});

	test("produces no blank tokens", () => {
		// Runs of two or more spaces, or a space beside a tab or newline, leave
		// a whitespace-only span behind in the scan; emitting it as a token
		// corrupts anything that reasons about adjacency, such as Vale's
		// `sequence` check.
		const cases = [
			"The  dog  runs.",
			"multiple    spaces",
			"tab\t\tseparated",
			"newline\n\nseparated",
			"mixed \t \n whitespace",
			"trailing   ",
			"   leading",
			"   ",
		];
		for (const src of cases) {
			for (const tok of tk.tokenize(src)) {
				expect(tok.text.trim()).not.toBe("");
			}
		}
	});

	test("matches prose's expected tokens over the corpus", () => {
		// `treebank_words.json` was generated before prose stopped normalizing
		// curly quotes -- the change that made offsets possible -- so the three
		// cases holding one differ by exactly that substitution. Folding the
		// quotes in what we got lets the rest of the table assert unchanged.
		const sents = corpus();
		const want = json<string[][]>("treebank_words.json");
		expect(sents.length).toBe(want.length);

		const fold = (s: string) =>
			s
				.replaceAll("“", '"')
				.replaceAll("”", '"')
				.replaceAll("‘", "'")
				.replaceAll("’", "'");

		for (let i = 0; i < sents.length; i++) {
			const got = tk.tokenize(sents[i]!).map((t) => fold(t.text));
			expect(got).toEqual(want[i]!.map(fold));
		}
	});

	test("takes replacement affixes and split cases", () => {
		const plain = new Tokenizer({ prefixes: [], suffixes: [], splitCases: [] });
		expect(plain.tokenize("Don't stop. $100!").map((t) => t.text)).toEqual([
			"Don't",
			"stop.",
			"$100!",
		]);
	});

	test("honors an extra special-case predicate", () => {
		const keep = new Tokenizer({ isSpecial: (s) => s === "a.b.c," });
		expect(keep.tokenize("a.b.c, d").map((t) => t.text)).toEqual(["a.b.c,", "d"]);
	});
});

describe("TreebankWordTokenizer", () => {
	const tb = new TreebankWordTokenizer();

	test("splits contractions and punctuation", () => {
		expect(tb.tokenize("They'll save and invest more.")).toEqual([
			"They",
			"'ll",
			"save",
			"and",
			"invest",
			"more",
			".",
		]);
		expect(tb.tokenize("I cannot do it.")).toEqual([
			"I",
			"can",
			"not",
			"do",
			"it",
			".",
		]);
		expect(tb.tokenize("Hi, my name can't hello,")).toEqual([
			"Hi",
			",",
			"my",
			"name",
			"ca",
			"n't",
			"hello",
			",",
		]);
	});

	test("rewrites straight quotes, which is why it carries no offsets", () => {
		expect(tb.tokenize('He said "hi" now.')).toEqual([
			"He",
			"said",
			"``",
			"hi",
			"''",
			"now",
			".",
		]);
	});

	test("splits brackets and dashes", () => {
		expect(tb.tokenize("a (b) -- c")).toEqual(["a", "(", "b", ")", "--", "c"]);
	});
});

describe("RegexpTokenizer", () => {
	test("word boundaries are what summarize counts words with", () => {
		expect(
			newWordBoundaryTokenizer().tokenize("It's a U.S.A. thing, 100%."),
		).toEqual(["It's", "a", "U.S.A.", "thing", "100"]);
	});

	test("word-punct splits letters from punctuation", () => {
		expect(newWordPunctTokenizer().tokenize("a.b, c!")).toEqual([
			"a",
			".",
			"b",
			",",
			"c",
			"!",
		]);
	});

	test("blank lines split paragraphs and drop the empties", () => {
		expect(newBlanklineTokenizer().tokenize("one\n\ntwo\n  \n three")).toEqual([
			"one",
			"two",
			"three",
		]);
	});
});
