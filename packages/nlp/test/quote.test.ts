import { describe, expect, test } from "bun:test";
import {
	closingQuote,
	openingQuote,
	quotedWords,
	quoteSpans,
} from "../src/quote.ts";

describe("quotedWords", () => {
	test("counts the words inside quotations", () => {
		// `nlp/quote_test.go`, case for case.
		const cases: Array<[string, number]> = [
			['"Get out," she said. He grumbled, "Fine."', 3],
			["No quotes here.", 0],
			["“Curly,” he said. ‘And single,’ she said.", 3],
			["An open quote \"runs to the paragraph's end", 5],
		];
		for (const [text, want] of cases) {
			expect(quotedWords(text)).toBe(want);
		}
	});
});

describe("openingQuote", () => {
	test("a straight mark opens only after a space, bracket or dash", () => {
		// The same character closes a quotation and means inches, so position
		// is the only thing that tells them apart.
		expect(openingQuote('he said "hi"', 0).at).toBe(8);
		expect(openingQuote('6" of snow', 0).at).toBe(-1);
		expect(openingQuote('("hi")', 0).at).toBe(1);
		expect(openingQuote('--"hi"', 0).at).toBe(2);
	});

	test("a mark at the start of the text always opens", () => {
		expect(openingQuote('"hi"', 0)).toEqual({ at: 0, size: 1, closer: 0x22 });
	});

	test("a curly mark opens after anything but a letter or digit", () => {
		expect(openingQuote("say“hi”", 0).at).toBe(-1);
		expect(openingQuote("say “hi”", 0).at).toBe(4);
		expect(openingQuote("(‘hi’", 0).closer).toBe(0x2019);
	});

	test("reports nothing when there is no mark", () => {
		expect(openingQuote("plain text", 0)).toEqual({
			at: -1,
			size: 0,
			closer: 0,
		});
	});

	test("starts looking where it is told", () => {
		const src = '"one" and "two"';
		expect(openingQuote(src, 1).at).toBe(10);
	});
});

describe("closingQuote", () => {
	test("returns the index just past the mark", () => {
		expect(closingQuote('"hi" rest', 0x22, 1)).toBe(4);
	});

	test("a curly single mark inside a word is an apostrophe", () => {
		// `don’t` and `Kenny’s` have to stay inside the quotation.
		const src = "‘don’t stop’ now";
		const end = closingQuote(src, 0x2019, 1);
		expect(src.slice(0, end)).toBe("‘don’t stop’");
	});

	test("reports -1 when nothing closes it", () => {
		expect(closingQuote('"unclosed', 0x22, 1)).toBe(-1);
	});
});

describe("quoteSpans", () => {
	test("pairs the marks and keeps them inside the span", () => {
		const src = '"Get out," she said. He grumbled, "Fine."';
		const spans = quoteSpans(src);
		expect(spans.map(([a, b]) => src.slice(a, b))).toEqual([
			'"Get out,"',
			'"Fine."',
		]);
	});

	test("an unclosed quotation runs to the end of its paragraph", () => {
		const src = 'He said "this runs on\n\nA new paragraph.';
		const spans = quoteSpans(src);
		expect(spans.length).toBe(1);
		expect(src.slice(spans[0]![0], spans[0]![1])).toBe('"this runs on');
	});

	test("an unclosed quotation in the last paragraph runs to the end", () => {
		const src = 'He said "this runs on';
		expect(quoteSpans(src)).toEqual([[8, src.length]]);
	});

	test("finds nothing in unquoted text", () => {
		expect(quoteSpans("no quotes here")).toEqual([]);
	});

	test("handles mixed mark kinds", () => {
		const src = "“Curly,” he said. ‘And single,’ she said.";
		expect(quoteSpans(src).map(([a, b]) => src.slice(a, b))).toEqual([
			"“Curly,”",
			"‘And single,’",
		]);
	});
});
