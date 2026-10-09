/**
 * Turning a match into a line and a column.
 *
 * Ported from `internal/core/location_test.go`.
 *
 * # Offsets
 *
 * Go counts bytes here; this port counts JavaScript string indices -- UTF-16
 * code units -- throughout, and characters where Go counts runes. A Go case
 * that asserts a *byte* offset over non-ASCII input therefore expects a
 * different number, and each one says so.
 *
 * `FuzzDirectPosition` is a Go fuzz target. It is ported as the property it
 * asserts, checked over its seed corpus and a deterministic sweep, since
 * `bun:test` has no fuzzing engine.
 */

import { describe, expect, test } from "bun:test";
import { segmentText, tokenizeWords } from "@vale-ts/nlp";
import { type Alert, newAlert } from "../src/alert.ts";
import { File } from "../src/file.ts";
import {
	countPrior,
	directPosition,
	initialPosition,
	insideInlineMarkup,
	isPunctOnly,
	lineStarts,
	locateMatch,
	locFromOffset,
	maskedOffset,
	maskMatch,
	quoteTolerantPattern,
	throughMask,
} from "../src/location.ts";
import { strLen } from "../src/util.ts";

/** `initialPosition` with the language layer wired in, as `File` calls it. */
function place(ctx: string, txt: string, a: Alert): [number, string] {
	return initialPosition(ctx, txt, a, segmentText, tokenizeWords);
}

/** `locateMatch` with the language layer wired in. */
function locate(ctx: string, txt: string, a: Alert, at: number) {
	return locateMatch(ctx, txt, a, at, segmentText, tokenizeWords);
}

// A punctuation-only match in a block whose text was altered by inline markup
// (e.g. a stripped code span) must still be located within that block, not at
// the first occurrence anywhere in the document -- see #994.
test("a punctuation-only match is anchored in its own block", () => {
	// ctx keeps the raw code span; txt is the extracted sentence without it.
	const ctx = "Test, line.\nLine, with, four, commas, `yes`.\n";
	const txt = "Line, with, four, commas, yes.";

	const [pos, sub] = place(ctx, txt, newAlert({ match: ",", span: [] }));
	// The comma belongs to the second sentence (after "Line"), not the first
	// comma in "Test,". Position is a 1-based character count.
	expect(pos).toBe(17);
	expect(sub).toBe(",");
});

// A match butted directly against a code span's delimiter is inside (or
// beside) that span, and locating an alert there mislocates it -- the prose
// occurrence the rule actually matched sits later in the line. `fs[1]` is
// exclusive, so the character to inspect is `ctx[fs[1]]` itself. See #1132's
// follow-up.
describe("insideInlineMarkup", () => {
	const cases: Array<{ name: string; ctx: string; fs: number[]; want: boolean }> = [
		{ name: "plain prose", ctx: "some ZQX here", fs: [5, 8], want: false },
		{ name: "opening backtick beside match", ctx: "x `ZQX` y", fs: [3, 6], want: true },
		{
			name: "closing backtick against match",
			ctx: "x `f() # ZQX` and ZQX y",
			fs: [9, 12],
			want: true,
		},
		{
			name: "prose occurrence after a span",
			ctx: "x `f() # ZQX` and ZQX y",
			fs: [18, 21],
			want: false,
		},
		{
			name: "hyphenated compound is not markup",
			ctx: "a well-known fix",
			fs: [2, 6],
			want: false,
		},
		{
			name: "opening math delimiter beside match",
			ctx: "x $ZQX$ y",
			fs: [3, 6],
			want: true,
		},
		{
			name: "closing math delimiter against match",
			ctx: "x $f(ZQX)$ and ZQX y",
			fs: [5, 8],
			want: false,
		},
		{
			name: "prose occurrence after math",
			ctx: "x $ZQX$ and ZQX y",
			fs: [12, 15],
			want: false,
		},
		{
			// Go writes this span as the byte offsets 19 and 22: eight `é`
			// characters are 16 bytes there. Counted in code units the same
			// `ZQX` sits at 11.
			name: "closing backtick past a multi-character prefix",
			ctx: "éééééééé x ZQX.` y",
			fs: [11, 14],
			want: true,
		},
	];

	test.each(cases)("$name", ({ ctx, fs, want }) => {
		expect(insideInlineMarkup(ctx, fs)).toBe(want);
	});
});

// A match shadowed by an identical string inside a code span must be located
// at its prose occurrence, not the span's.
test("a match shadowed by a code span is located in the prose", () => {
	const ctx = "Inline `sum(x) # ZQX` and text ZQX after.";
	const txt = "Inline ************ and text ZQX after.";

	const [pos] = place(ctx, txt, newAlert({ match: "ZQX", span: [] }));
	expect(pos).toBe(32);
});

// A match preceded, within its block, by copies of its own text must be
// located at its own occurrence, not the first. `skipOcc` carries the count,
// measured by `addAlert` where the span and the block text share a coordinate
// system -- the word-masking this replaced sliced a document-sized context at
// a block-sized span, and was capped at contexts under 1,000 bytes.
test("prior occurrences within the block are skipped", () => {
	const ctx = "One and two and three and four.";

	for (const [skip, want] of [
		[0, 5],
		[1, 13],
		[2, 23],
	]) {
		const a = newAlert({ match: "and", span: [0, 0], skipOcc: skip });
		const [pos] = place(ctx, "unfindable block text", a);
		expect(pos, `skip ${skip}`).toBe(want!);
	}
});

describe("countPrior", () => {
	const cases: Array<{ text: string; sub: string; want: number }> = [
		{ text: "say and stay", sub: "and", want: 1 },
		{ text: "band width", sub: "and", want: 0 }, // no boundary
		{ text: "`and` beside and", sub: "and", want: 1 }, // inline code doesn't count
		{ text: "and one and two and ", sub: "and", want: 3 },
		{ text: "nothing here", sub: "and", want: 0 },
		{ text: "", sub: "and", want: 0 },
	];

	test.each(cases)("$text", ({ text, sub, want }) => {
		expect(countPrior(text, sub)).toBe(want);
	});
});

describe("isPunctOnly", () => {
	test("holds no letters or digits", () => {
		const cases: Record<string, boolean> = {
			",": true,
			"...": true,
			"": false,
			hav: false,
			"that's": false,
			OAuth2: false,
		};
		for (const [input, want] of Object.entries(cases)) {
			expect(isPunctOnly(input), input).toBe(want);
		}
	});
});

// A match whose smart apostrophe/quote was normalized to ASCII (as
// spell-checking does) must still be located in the original source. Before
// the fix, the straight-apostrophe match couldn't be found in smart-apostrophe
// text, so the alert was dropped -- see #1003.
describe("a normalized apostrophe is found in the source", () => {
	const straight = "The toolkit's plugin."; // a.match is always normalized
	const smart = "The toolkit’s plugin."; // source keeps the smart form

	test.each([
		["straight source", straight],
		["smart source", smart],
	])("%s", (_name, ctx) => {
		const [pos, sub] = place(ctx, ctx, newAlert({ match: "toolkit's", span: [] }));
		expect(pos).toBe(5);
		expect(sub).toBe("toolkit's");
	});
});

/**
 * The position the pattern search reports -- what `directPosition` has to
 * agree with whenever it accepts an offset.
 */
function searchPosition(ctx: string, sub: string): [number, boolean] {
	const pat = new RegExp(`(?:^|\\b|_)${quoteTolerantPattern(sub)}(?:_|\\b|$)`, "u");

	const fs = pat.exec(ctx);
	if (fs === null) return [0, false];

	let idx = fs.index;
	if (ctx.slice(idx).startsWith("_")) idx++;

	return [idx, true];
}

/**
 * `directPosition` trades a search for arithmetic, so its whole value rests on
 * never accepting an offset the search would have disagreed with. Two ways to
 * get that wrong are easy to reach and hard to see: quote tolerance runs one
 * way only (an ASCII apostrophe in the match may stand for a smart one in the
 * source, never the reverse), and the pattern's `_` alternatives *consume* the
 * underscore rather than looking past it, so it lands inside the match and
 * cannot begin the next one.
 */
describe("directPosition agrees with the search", () => {
	/** Go's fuzz seed corpus. */
	const seeds: Array<[string, string, number]> = [
		["the quick brown fox", "brown", 4],
		["a_word_here", "word", 2],
		["_leading", "leading", 1],
		["the toolkit’s plugin", "toolkit's", 4],
		["the toolkit's plugin", "toolkit’s", 4],
		["alpha beta alpha", "alpha", 11],
		["@@@@@ word", "word", 6],
		["`code` word", "word", 7],
		["'_0ZaAZ _", "0ZaAZ", 2],
	];

	/**
	 * The property the fuzz target asserts, reporting whether the offset was
	 * accepted so that a sweep can say it was not vacuous.
	 */
	function check(ctx: string, sub: string, idx: number): boolean {
		if (sub === "") return false;
		// from=0 asks the strongest question: is this the first match in the
		// whole context, which is exactly what the search returns.
		if (!directPosition(ctx, idx, 0, sub)) return false;

		const [want, found] = searchPosition(ctx, sub);
		expect(
			found,
			`accepted ${idx} in ${JSON.stringify(ctx)} for ${JSON.stringify(sub)}, but the search finds nothing`,
		).toBe(true);
		expect(
			want,
			`accepted ${idx} in ${JSON.stringify(ctx)} for ${JSON.stringify(sub)}`,
		).toBe(idx);
		return true;
	}

	test("over the seed corpus", () => {
		let accepted = 0;
		for (const [ctx, sub, idx] of seeds) {
			if (check(ctx, sub, idx)) accepted++;
		}
		// The seeds are offsets `directPosition` should take; if it stopped
		// taking any of them the agreement above would hold trivially.
		expect(accepted).toBeGreaterThan(3);
	});

	test("over a deterministic sweep", () => {
		// The alphabet holds exactly what makes the boundaries subtle: word
		// characters, an underscore, both apostrophes, a backtick and a space.
		const alphabet = [..."ab_ '’`@"];
		// A small linear congruential generator, so the sweep is the same on
		// every run and a failure can be reproduced.
		let seed = 0x2545f491;
		const next = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const pick = (n: number): string => {
			let out = "";
			for (let i = 0; i < n; i++) out += alphabet[next(alphabet.length)]!;
			return out;
		};

		let accepted = 0;
		for (let round = 0; round < 3000; round++) {
			const ctx = pick(1 + next(10));
			const sub = pick(1 + next(3));
			for (let idx = 0; idx <= ctx.length; idx++) {
				if (check(ctx, sub, idx)) accepted++;
			}
		}
		// A sweep that accepts nothing asserts nothing.
		expect(accepted).toBeGreaterThan(100);
	});
});

/**
 * The previous implementation: count newlines from the start of the document
 * on every call. The indexed version has to agree with it exactly.
 */
function locByScan(
	ctx: string,
	begin: number,
	end: number,
	pad: number,
): [number, number[]] {
	let line = 1;
	let lineStart = 0;

	for (let i = 0; i < begin && i < ctx.length; i++) {
		if (ctx[i] === "\n") {
			line++;
			lineStart = i + 1;
		}
	}

	const col = strLen(ctx.slice(lineStart, begin)) + 1 + pad;
	const matchLen = strLen(ctx.slice(begin, end));

	const span = [col, col + matchLen - 1];
	if (span[1]! < span[0]!) span[1] = span[0]!;

	return [line, span];
}

const SCAN_INPUTS = [
	"",
	"one line",
	"a\nb\nc",
	"\n\n\nleading blanks",
	"trailing\n",
	"héllo\nwörld\n日本語\n👍🏽 emoji",
	"win\r\nline\r\nendings",
];

test("locFromOffset agrees with a full scan", () => {
	for (const ctx of SCAN_INPUTS) {
		const starts = lineStarts(ctx);
		for (let begin = 0; begin <= ctx.length; begin++) {
			for (let end = begin; end <= ctx.length; end++) {
				for (const pad of [0, 3]) {
					const want = locByScan(ctx, begin, end, pad);
					const got = locFromOffset(ctx, starts, begin, end, pad);
					expect(
						got,
						`ctx=${JSON.stringify(ctx)} begin=${begin} end=${end} pad=${pad}`,
					).toEqual(want);
				}
			}
		}
	}
});

// The index is cached per context; a different context must rebuild it.
test("lineStarts rebuilds on a new context", () => {
	const f = new File();

	expect(f.lineStarts("a\nb")).toHaveLength(2);
	expect(f.lineStarts("a\nb\nc\nd")).toHaveLength(4);
	expect(f.lineStarts("a\nb")).toHaveLength(2);
});

/** `File.offsetLoc`, which is Go's unexported `byteLoc`. */
type OffsetLoc = (
	ctx: string,
	begin: number,
	end: number,
	pad: number,
) => [number, number[]];

function offsetLocOf(f: File): OffsetLoc {
	const held = f as unknown as { offsetLoc: OffsetLoc };
	return (ctx, begin, end, pad) => held.offsetLoc(ctx, begin, end, pad);
}

// The running column count must agree with counting from the line's start,
// whether alerts arrive in order along a line, jump back, or change lines.
test("offsetLoc agrees with a full scan", () => {
	for (const ctx of SCAN_INPUTS.slice(1)) {
		const f = new File();
		const offsetLoc = offsetLocOf(f);

		const begins: number[] = [];
		for (let begin = 0; begin <= ctx.length; begin++) begins.push(begin);
		// Forward, then backward, then forward again: every branch of the
		// cache in one context.
		const order = [...begins, ...[...begins].reverse(), ...begins];

		for (const begin of order) {
			const end = Math.min(begin + 2, ctx.length);
			for (const pad of [0, 3]) {
				const want = locByScan(ctx, begin, end, pad);
				const got = offsetLoc(ctx, begin, end, pad);
				expect(
					got,
					`ctx=${JSON.stringify(ctx)} begin=${begin} end=${end} pad=${pad}`,
				).toEqual(want);
			}
		}
	}
});

// A new context restarts the count even when a position repeats.
test("offsetLoc restarts across contexts", () => {
	const f = new File();
	const offsetLoc = offsetLocOf(f);

	offsetLoc("aaaa", 3, 4, 0);
	// Go asks for byte offset 4 of "éééé", which is two 2-byte characters in;
	// the same place is code-unit offset 2 here. Either way the column is 3.
	const [, span] = offsetLoc("éééé", 2, 3, 0);
	expect(span[0]).toBe(3);
});

// A block the walker placed is located where it was placed, even when the
// same text occurs earlier; and the match is masked where it was found, not at
// its first occurrence as a substring of another word.
test("locateMatch trusts the reader's placement", () => {
	const ctx = "| Name |\n\n| Name |\n";
	const found = locate(ctx, "Name", newAlert({ match: "Name", span: [0, 4] }), 12);
	expect([found.column, found.hit]).toEqual([13, 12]);

	expect(maskMatch("Subtitles.\nSay titl.\n", "titl", 15)).toBe(
		"Subtitles.\nSay ####.\n",
	);
	expect(maskMatch("Say titl.\n", "titl", -1)).toBe("Say ####.\n");
});

// A block's later matches are located in that block, not in a later copy of
// its text, although the earlier matches have been masked out of it.
test("locateMatch reads the block through an earlier mask", () => {
	const ctx = "######## here and iptables again.\n\niptables here and iptables again.\n";
	const txt = "iptables here and iptables again.";
	const found = locate(
		ctx,
		txt,
		newAlert({ match: "iptables", span: [18, 26], skipOcc: 1 }),
		0,
	);
	expect([found.column, found.hit]).toEqual([19, 18]);
});

// A mask keeps the character count and not the byte count, so a block whose
// earlier match was a multi-byte character must still be found at its offset,
// and the offset itself has to be carried over to the shortened context. See
// #1184.
test("locateMatch reads the block through a multi-character mask", () => {
	const ctx = '"\'’\n\n”’';
	const txt = "”’";

	// Go masks at byte offset 7, where the `”` starts; counted in code units
	// that is 5.
	const masked = maskMatch(ctx, "”", 5);
	expect(masked).toBe('"\'’\n\n#’');

	expect(throughMask(masked.slice(5), txt)).toBe(true);
	expect(throughMask("#x", "”y")).toBe(false);

	// Go's `”` is three bytes and its mask one, so the copy is shorter there
	// and the offsets 7 and 13 map to 7 and 11. Every character here is one
	// code unit, so the copy has the same length and the offsets carry over
	// unchanged; the astral case below is the one that shortens.
	expect(maskedOffset(ctx, masked, 5)).toBe(5);
	expect(maskedOffset(ctx, masked, ctx.length)).toBe(masked.length);
	expect(maskedOffset(ctx, ctx, 5)).toBe(5);

	// The second `’` is the one in the block, not the one on line 1. Go's span
	// is [3, 6], the bytes of the block's second character; here it is [1, 2].
	const found = locate(masked, txt, newAlert({ match: "’", span: [1, 2] }), 5);
	expect([found.column, found.hit]).toEqual([7, 6]);
});

// Not from the Go suite: a character outside the BMP is two code units and its
// mask is one, so masking does shorten the context here -- which is the case
// Go's multi-byte input exercises and this port's BMP input cannot.
test("maskedOffset carries an offset into a shortened copy", () => {
	const ctx = "a👍b";
	const masked = maskMatch(ctx, "👍", 1);

	expect(masked).toBe("a#b");
	expect(masked.length).toBeLessThan(ctx.length);
	// 'b' is at 3 in the original and 2 in the copy.
	expect(maskedOffset(ctx, masked, 3)).toBe(2);
	expect(maskedOffset(ctx, masked, 1)).toBe(1);
});

// A match that wraps across a line break is placed although the source's next
// line starts with a list item's indentation or a blockquote's marker, which
// the block's text does not carry. See #1185.
test("locateMatch places a match that wraps a line", () => {
	const a = newAlert({ match: "the old\nmodel", span: [16, 29] });
	const txt = "Bullet: this is the old\nmodel here.";

	for (const tc of [
		{ ctx: "- Bullet: this is the old\n  model here.\n", want: 19 },
		{ ctx: "> Bullet: this is the old\n> model here.\n", want: 19 },
		{ ctx: "> > Bullet: this is the old\n> > model here.\n", want: 21 },
	]) {
		const found = locate(tc.ctx, txt, { ...a, span: [16, 29] }, -1);
		expect([found.column, found.hit], tc.ctx).toEqual([tc.want, tc.want - 1]);

		const masked = maskMatch(tc.ctx, a.match, found.hit);
		expect(masked, tc.ctx).not.toContain("old");
		expect(masked, tc.ctx).not.toContain("model");
		expect(masked, tc.ctx).toContain("here.");
	}
});
