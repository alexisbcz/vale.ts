import { describe, expect, test } from "bun:test";
import { IterTokenizer, wordTokenizer } from "../src/tokenize.ts";

/** `nlp/tokenize_test.go`, case for case. */
const cases: Array<{ input: string; output: string[] }> = [
	{
		input: "Don't copy this sentence.",
		output: ["Don't", "copy", "this", "sentence"],
	},
	{
		input: "no 'automatic' before it.",
		output: ["no", "automatic", "before", "it"],
	},
	{
		input: "I matter-of-factly said no.",
		output: ["I", "matter-of-factly", "said", "no"],
	},
	{
		input: "* `foof` - A string slice",
		output: ["`foof`", "A", "string", "slice"],
	},
];

describe("IterTokenizer", () => {
	test("splits the way Go's WordTokenizer does", () => {
		for (const c of cases) {
			expect(wordTokenizer.tokenize(c.input)).toEqual(c.output);
		}
	});

	test("keeps abbreviations and emoticons whole", () => {
		expect(wordTokenizer.tokenize("I visited the U.S.A. last year.")).toEqual([
			"I",
			"visited",
			"the",
			"U.S.A.",
			"last",
			"year",
		]);
		// `:-)` holds no letters, so `addToken` drops it; `8-D` does, so it stays.
		expect(wordTokenizer.tokenize("Well done 8-D")).toEqual([
			"Well",
			"done",
			"8-D",
		]);
		expect(wordTokenizer.isSpecial(":-)")).toBe(true);
		expect(wordTokenizer.isSpecial("Mr.")).toBe(true);
		expect(wordTokenizer.isSpecial("word")).toBe(false);
	});

	test("normalizes curly quotes and the one entity Vale rewrites", () => {
		expect(wordTokenizer.tokenize("“It’s fine,” she said")).toEqual([
			"It's",
			"fine",
			"she",
			"said",
		]);
		expect(wordTokenizer.tokenize("It&rsquo;s fine")).toEqual(["It's", "fine"]);
	});

	test("drops runs with no letters in them", () => {
		expect(wordTokenizer.tokenize("100 -- 200 ( ) !")).toEqual([]);
	});

	describe("offsets", () => {
		test("locate their token in the source", () => {
			const src = "Don't (really) copy this sentence.";
			const { tokens, offsets } = wordTokenizer.tokenizeWithOffsets(src);
			expect(tokens.length).toBe(offsets.length);
			for (let i = 0; i < tokens.length; i++) {
				expect(offsets[i]).toBeGreaterThanOrEqual(0);
				expect(src.slice(offsets[i]!, offsets[i]! + tokens[i]!.length)).toBe(
					tokens[i]!,
				);
			}
		});

		test("march forward over repeated words", () => {
			const src = "the cat sat on the mat and the cat sat again";
			const { tokens, offsets } = wordTokenizer.tokenizeWithOffsets(src);
			let prev = -1;
			for (let i = 0; i < tokens.length; i++) {
				expect(offsets[i]).toBeGreaterThan(prev);
				prev = offsets[i]!;
			}
		});

		test("are -1 for a word the sanitizer rewrote", () => {
			// `It's` is not a substring of `It’s`, so there is nothing to
			// point at and the tokenizer says so rather than guessing.
			const { tokens, offsets } = wordTokenizer.tokenizeWithOffsets("It’s fine");
			expect(tokens).toEqual(["It's", "fine"]);
			expect(offsets[0]).toBe(-1);
			expect(offsets[1]).toBe(5);
		});

		test("survive astral characters", () => {
			const src = "emoji \u{1f389} and words";
			const { tokens, offsets } = wordTokenizer.tokenizeWithOffsets(src);
			for (let i = 0; i < tokens.length; i++) {
				expect(src.slice(offsets[i]!, offsets[i]! + tokens[i]!.length)).toBe(
					tokens[i]!,
				);
			}
		});
	});

	test("a fresh instance behaves like the shared one", () => {
		const own = new IterTokenizer();
		for (const c of cases) {
			expect(own.tokenize(c.input)).toEqual(wordTokenizer.tokenize(c.input));
		}
	});

	test("terminates on a lone affix", () => {
		// `hasAnyPrefix` and `hasAnySuffix` both require the token to be longer
		// than the affix; without that the strip loop would never shorten `"`.
		expect(wordTokenizer.tokenize('" ( ) ,')).toEqual([]);
	});
});
