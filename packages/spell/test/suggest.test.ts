/**
 * Scores the suggester against Hunspell's `.sug` files: for each wrong word,
 * whether Hunspell's first suggestion is among the top five here.
 *
 * Only fixtures whose `.sug` has a line per wrong word are scored; Hunspell
 * writes no line for a word it has no suggestion for, so the others cannot be
 * aligned.
 */

import { expect, test } from "bun:test";

import { distance, similarity } from "../src/index.ts";
import {
	hunspellLines,
	hunspellSpeller,
	hunspellStems,
	speller,
} from "./helpers.ts";

/**
 * The fewest of Hunspell's first suggestions each fixture's checker must
 * place in its top five.
 *
 * It is raised as the suggester improves and never lowered, so a regression
 * fails the run.
 */
const floors: Record<string, number> = {
	"1463589": 5,
	"1463589_utf": 5,
	"1695964": 3,
	IJ: 1,
	allcaps: 3,
	allcaps2: 2,
	allcaps_utf: 3,
	base: 11,
	base_utf: 13,
	checksharpsutf: 1,
	forceucase: 2,
	i35725: 10,
	i54633: 2,
	i58202: 13,
	keepcase: 8,
	map: 3,
	maputf: 3,
	oconv: 0,
	opentaal_keepcase: 6,
	ph: 9,
	phone: 1,
	reputf: 1,
	sug2: 3,
	sugutf: 12,
	utf8_nonbmp: 2,
};

/** The stems whose `.sug` lines up with their `.wrong`. */
function scorable(): string[] {
	return hunspellStems().filter((stem) => {
		const wrong = hunspellLines(`hunspell/${stem}.wrong`);
		const want = hunspellLines(`hunspell/${stem}.sug`);
		return wrong.length > 0 && wrong.length === want.length;
	});
}

for (const stem of scorable()) {
	const floor = floors[stem];
	test(`suggestions for hunspell/${stem}`, () => {
		const wrong = hunspellLines(`hunspell/${stem}.wrong`);
		const want = hunspellLines(`hunspell/${stem}.sug`);
		const gs = hunspellSpeller(stem);

		let hits = 0;
		const misses: string[] = [];
		for (let i = 0; i < wrong.length; i++) {
			const word = (wrong[i] as string).trim();
			const first = ((want[i] as string).split(", ")[0] as string).trim();
			const got = gs.suggest(word);
			if (got.includes(first)) hits++;
			else misses.push(`${word}: want "${first}", got ${JSON.stringify(got)}`);
		}

		if (floor === undefined) {
			// An unlisted fixture is only reported on, as it is in Go.
			expect(hits).toBeGreaterThanOrEqual(0);
			return;
		}
		expect(hits, `below the floor of ${floor}:\n  ${misses.join("\n  ")}`).toBe(
			floor,
		);
	});
}

test("the REP table drives the first suggestions", () => {
	// `f` for `ph` is a REP entry, so `fone` suggests `phone` before anything
	// the edit distance would find.
	const gs = speller("SET UTF-8\nREP 1\nREP f ph\n", "3\nphone\nfine\nbone\n");
	expect(gs.suggest("fone")[0]).toBe("phone");
});

test("a REP entry may write one word as two", () => {
	const gs = speller("SET UTF-8\nREP 1\nREP alot a_lot\n", "2\na\nlot\n");
	expect(gs.suggest("alot")).toContain("a lot");
});

test("a word that splits into two is suggested as two", () => {
	const gs = speller("SET UTF-8\n", "2\nhello\nworld\n");
	expect(gs.suggest("helloworld")).toContain("hello world");
});

test("suggestions are ordered by closeness, ties by spelling", () => {
	const gs = speller("SET UTF-8\n", "4\ncat\ncot\ncut\nelephant\n");
	// Each of cat, cot and cut is one edit from `cit`, so the tie is broken
	// the same way every run; `elephant` is nowhere near and comes last.
	expect(gs.suggest("cit")).toEqual(["cat", "cot", "cut", "elephant"]);
});

test("the suggester hands back at most five candidates", () => {
	const dic = ["7", "cat", "cot", "cut", "cab", "car", "can", "cap"].join("\n");
	expect(speller("SET UTF-8\n", dic).suggest("cit").length).toBe(5);
});

test("similarity and distance measure in code points", () => {
	expect(distance("kitten", "sitting")).toBe(3);
	expect(similarity("kitten", "sitting")).toBeCloseTo(1 - 3 / 7, 12);
	expect(similarity("abc", "abc")).toBe(1);
	expect(similarity("", "abc")).toBe(0);
	// An astral character is one code point, so one edit.
	expect(distance("a\u{1F600}", "ab")).toBe(1);
});
