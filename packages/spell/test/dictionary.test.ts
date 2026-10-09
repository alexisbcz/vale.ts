/**
 * The checker against real dictionary files rather than inline snippets:
 * OpenOffice's `en_US` pair, which exercises prefixes, suffixes, their
 * cross-product and the REP table, and Hunspell's COMPOUNDRULE fixtures.
 */

import { expect, test } from "bun:test";

import {
	decodeDictionary,
	decodeDictionaryText,
	newGoSpell,
	newGoSpellBytes,
	splitEntry,
} from "../src/index.ts";
import { fixturePath, hunspellSpeller, readFixture } from "./helpers.ts";

test("a real .aff/.dic pair is read from disk", () => {
	const gs = newGoSpell(
		fixturePath("hunspell/base.aff"),
		fixturePath("hunspell/base.dic"),
	);
	for (const [word, want] of Object.entries({
		created: true,
		uncreated: true, // the U prefix
		creations: true, // the X suffix on `create/XKVNGADS`
		recreate: true, // the A prefix
		recreated: true, // the A prefix crossed with the D suffix
		FAQs: true, // the S suffix
		"FAQ's": true, // the M suffix
		"etc.": true, // a trailing period is the sentence's
		uncreatedly: false,
		zorbblat: false,
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

test("the same pair read from bytes behaves alike", () => {
	const gs = newGoSpellBytes(
		readFixture("hunspell/base.aff"),
		readFixture("hunspell/base.dic"),
	);
	expect(gs.spell("uncreated")).toBe(true);
	expect(gs.spell("sawyer")).toBe(true);
	expect(gs.spell("zorbblat")).toBe(false);
});

test("the REP table is used before the edit distance", () => {
	// Hunspell's own REP fixture: `ph` for `f`, and one word written as two.
	const gs = hunspellSpeller("rep");
	expect(gs.suggest("phorm")[0]).toBe("form");
	expect(gs.suggest("fantom")[0]).toBe("phantom");
	expect(gs.suggest("alot")).toContain("a lot");
});

test("a COMPOUNDRULE builds words the .dic never lists", () => {
	const gs = hunspellSpeller("compoundrule2"); // COMPOUNDRULE A*B*C*
	for (const word of ["aa", "ab", "aabbcc", "bc", "ccc", "abcc"]) {
		expect(gs.spell(word), word).toBe(true);
	}
	// The order the rule fixes is the only one allowed.
	for (const word of ["ba", "cba", "cab", "acb"]) {
		expect(gs.spell(word), word).toBe(false);
	}
});

test("a COMPOUNDRULE spells a number with a unit", () => {
	const gs = hunspellSpeller("compoundrule5"); // N*%? and NN*.NN*%?
	for (const word of ["10%", "0.2%", "123.4561\u2030", "10.25"]) {
		expect(gs.spell(word), word).toBe(true);
	}
	expect(gs.spell("%10")).toBe(false);
});

test("decodeDictionary reads the encoding SET declares", () => {
	// 0xfc is ü in ISO8859-1 and is not valid UTF-8.
	const latin1 = Uint8Array.from(
		"SET ISO8859-1\nSFX U Y 1\nSFX U 0 \xfcr .\n",
		(c) => c.charCodeAt(0),
	);
	expect(decodeDictionary(latin1, new Uint8Array()).aff).toContain("ür");

	// Without SET, a file that is valid UTF-8 is read as UTF-8.
	const utf8 = new TextEncoder().encode("TRY ü\n");
	expect(decodeDictionary(utf8, new Uint8Array()).aff).toBe("TRY ü\n");

	// Without SET, a file that is not valid UTF-8 falls back to ISO8859-1.
	expect(
		decodeDictionary(Uint8Array.from([0xfc, 0x0a]), new Uint8Array()).aff,
	).toBe("ü\n");

	// A byte order mark is not part of the first directive.
	const bom = new Uint8Array([
		0xef, 0xbb, 0xbf, 0x53, 0x45, 0x54, 0x20, 0x55, 0x54, 0x46, 0x2d, 0x38, 0x0a,
	]);
	expect(decodeDictionary(bom, new Uint8Array()).aff).toBe("SET UTF-8\n");

	// An encoding nothing can read is refused by name.
	expect(() => decodeDictionaryText("SET NOT-A-CHARSET\n", "")).toThrow(
		/unsupported encoding/,
	);
});

test("splitEntry keeps a slash that belongs to the word", () => {
	expect(splitEntry("walk/S")).toEqual(["walk", "S", true]);
	expect(splitEntry("walk")).toEqual(["walk", "", false]);
	// A slash in the first position is part of the word.
	expect(splitEntry("/dev/S")).toEqual(["/dev", "S", true]);
	// An escaped slash is a slash.
	expect(splitEntry("CI\\/CD/M")).toEqual(["CI/CD", "M", true]);
	expect(splitEntry("CI\\/CD")).toEqual(["CI/CD", "", false]);
});

test("lookups are memoized without changing the answer", () => {
	const gs = hunspellSpeller("base");
	for (let i = 0; i < 3; i++) {
		expect(gs.spell("uncreated")).toBe(true);
		expect(gs.spell("zorbblat")).toBe(false);
	}
	// A fork shares the dictionary but not the ignore list.
	const other = gs.fork();
	gs.addWordRaw("zorbblat");
	expect(gs.spell("zorbblat")).toBe(true);
	expect(other.spell("zorbblat")).toBe(false);
});

test("a missing file is reported by which one it was", () => {
	expect(() => newGoSpell("/nope.aff", "/nope.dic")).toThrow(/unable to open aff/);
	expect(() => newGoSpell(fixturePath("hunspell/base.aff"), "/nope.dic")).toThrow(
		/unable to open dic/,
	);
});
