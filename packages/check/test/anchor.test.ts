import { describe, expect, test } from "bun:test";
import { Block, newAlert } from "@vale-ts/core";
import { anchor, re2Loc, runeSpanToBytes } from "../src/index.ts";

/**
 * `runeSpanToBytes` underpins every anchored alert. In this port there is one
 * offset unit, so it is a bounds check rather than a conversion -- but an
 * off-by-one here mislocates findings rather than failing loudly.
 */
describe("runeSpanToBytes", () => {
	const cases: Array<[string, string, number, number, string, boolean]> = [
		["ascii start", "hello world", 0, 5, "hello", true],
		["ascii middle", "hello world", 6, 11, "world", true],
		["ascii to end", "hello", 0, 5, "hello", true],
		["empty span", "hello", 2, 2, "", true],
		["multibyte", "héllo wörld", 6, 11, "wörld", true],
		["whole string", "naïve", 0, 5, "naïve", true],
		["negative", "abc", -1, 2, "", false],
		["reversed", "abc", 2, 1, "", false],
		["past the end", "abc", 0, 4, "", false],
	];

	for (const [name, s, from, to, want, ok] of cases) {
		test(name, () => {
			const [lo, hi, got] = runeSpanToBytes(s, from, to);
			expect(got).toBe(ok);
			if (ok) expect(s.slice(lo, hi)).toBe(want);
		});
	}
});

/**
 * `re2Loc` must agree with the straightforward implementation -- slice the
 * string -- on every span, including the out-of-bounds ones.
 */
test("re2Loc agrees with slicing, and refuses what does not fit", () => {
	const inputs = [
		"",
		"hello",
		"héllo wörld",
		"日本語のテキスト",
		"emoji 👍🏽 here",
		"mixed ascii ünd 日本 and 🎉 too",
	];

	for (const s of inputs) {
		const blk = new Block("", s, "text");
		for (let from = -2; from <= s.length + 2; from++) {
			for (let to = -2; to <= s.length + 2; to++) {
				const ok = from >= 0 && to <= s.length && from <= to;
				if (ok) expect(re2Loc(blk, [from, to])).toBe(s.slice(from, to));
				else expect(() => re2Loc(blk, [from, to])).toThrow();
			}
		}
	}
});

/**
 * A block whose text inline markup rewrote has no offset of its own, and its
 * alerts used to fall back to a text search that placed them on the wrong line
 * -- or dropped them. Its runs place them exactly.
 */
describe("anchoring from a block's runs", () => {
	// "  <p>ab <b>cd</b> e</p>" read as "ab cd e".
	function blockWithRuns(): Block {
		const blk = new Block("  <p>ab <b>cd</b> e</p>", "ab cd e", "text");
		blk.offset = -1;
		blk.runs = [
			{ at: 0, src: 5, n: 3 }, // "ab "
			{ at: 3, src: 11, n: 2 }, // "cd"
			{ at: 5, src: 17, n: 2 }, // " e"
		];
		return blk;
	}

	const cases: Array<[string, number[], number[] | null]> = [
		// "ab cd" reaches from the first character to the last, `<b>` included.
		["across the markup", [0, 5], [5, 13]],
		["before it", [0, 2], [5, 7]],
		["after it", [3, 5], [11, 13]],
		["past the last run", [0, 30], null],
		// An empty match sits before the character it names.
		["empty at the start", [0, 0], [5, 5]],
		["empty before the markup", [3, 3], [11, 11]],
		["empty at the end", [7, 7], [19, 19]],
		["empty past the end", [8, 8], null],
	];

	for (const [name, span, want] of cases) {
		test(name, () => {
			const a = newAlert({ span });
			anchor(a, blockWithRuns());
			if (want === null) {
				expect(a.hasByteOffsets ?? false).toBe(false);
				return;
			}
			expect(a.hasByteOffsets).toBe(true);
			expect(a.span).toEqual(want);
		});
	}
});

test("a placed block anchors by arithmetic", () => {
	const ctx = "first line\nsecond line\n";
	const blk = new Block(ctx, "second line", "text");
	blk.offset = "first line\n".length;

	const a = newAlert({ span: [7, 11] });
	anchor(a, blk);
	expect(a.hasByteOffsets).toBe(true);
	expect(a.span).toEqual([blk.offset + 7, blk.offset + 11]);
	expect(ctx.slice(a.span[0]!, a.span[1]!)).toBe("line");
});
