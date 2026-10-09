import { describe, expect, test } from "bun:test";

import { DictConfig, defaultCompoundMin, newDictConfig } from "../src/index.ts";
import { speller } from "./helpers.ts";

/** A `DictConfig` with nothing but a FLAG type, for the flag-splitting tests. */
function withFlag(flag: string): DictConfig {
	const dc = new DictConfig();
	dc.flag = flag;
	// A bare DictConfig has not seen SET, where the reader decides whether a
	// flag is a byte or a character; the ASCII cases below are the same
	// either way.
	return dc;
}

describe("parseFlags", () => {
	test("ASCII gives one flag per character", () => {
		expect(withFlag("ASCII").parseFlags("ABC")).toEqual(["A", "B", "C"]);
	});

	test("num splits on commas", () => {
		expect(withFlag("num").parseFlags("14308,10482,4720")).toEqual([
			"14308",
			"10482",
			"4720",
		]);
	});

	test("long gives one flag per pair", () => {
		expect(withFlag("long").parseFlags("AABB")).toEqual(["AA", "BB"]);
	});

	test("UTF-8 gives one flag per character", () => {
		expect(withFlag("UTF-8").parseFlags("AğB")).toEqual(["A", "ğ", "B"]);
	});
});

test("FLAG num names affix classes by number", () => {
	const aff = newDictConfig(`SET UTF-8
FLAG num

SFX 100 N 1
SFX 100 0 ler .

SFX 200 N 1
SFX 200 0 in .
`);

	expect(aff.flag).toBe("num");

	const a100 = aff.affixMap.get("100");
	expect(a100).toBeDefined();
	expect(a100?.rules.map((r) => r.affixText)).toEqual(["ler"]);

	const a200 = aff.affixMap.get("200");
	expect(a200).toBeDefined();
	expect(a200?.rules.map((r) => r.affixText)).toEqual(["in"]);
});

// French dictionaries declare `FLAG long` and use `--` as the NOSUGGEST flag.
test("NOSUGGEST reads a long flag", () => {
	const aff = newDictConfig(`SET UTF-8
FLAG long
NOSUGGEST --

SFX Aa Y 1
SFX Aa 0 s .
`);
	expect(aff.noSuggestFlag).toBe("--");
	expect(aff.affixMap.has("Aa")).toBe(true);
});

test("FLAG num expands an entry", () => {
	const aff = newDictConfig(`SET UTF-8
FLAG num

SFX 100 N 1
SFX 100 0 ler .

SFX 200 N 1
SFX 200 0 in .
`);
	expect(aff.expand("belge/100,200").sort()).toEqual([
		"belge",
		"belgein",
		"belgeler",
	]);
});

test("FLAG num reaches the speller", () => {
	const gs = speller(
		`SET UTF-8
FLAG num

SFX 100 N 1
SFX 100 0 ler .

SFX 200 N 1
SFX 200 0 nin .
`,
		"2\nbelge/100,200\nsistem/100,200\n",
	);

	for (const [word, want] of Object.entries({
		belge: true,
		belgeler: true,
		belgenin: true,
		sistem: true,
		sistemler: true,
		sistemnin: true,
		bilinmeyen: false,
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

// The three parsing bugs the stavekontrolden.dk Danish dictionary exposed:
//
//  1. An affix that carries its own continuation flags (`t/34,22`) must have
//     those flags stripped from the generated word.
//  2. Space-separated morphology (`coitus/10,39,31 al:coituum`) must be
//     stripped so it does not corrupt FLAG num parsing.
//  3. A single malformed entry (`/34 st:coitus`, flags but no word) must not
//     abort the whole dictionary, which would flag every word.
test("a Danish dictionary's continuation flags and morphology", () => {
	const gs = speller(
		`SET UTF-8
FLAG num

SFX 1 Y 1
SFX 1 0 t/34,22 e

SFX 34 Y 1
SFX 34 0 s .
`,
		"3\nstave/1,34 al:stave\ncoituum\n/34 st:coitus\n",
	);

	for (const [word, want] of Object.entries({
		stave: true, // base word, morphology stripped
		stavet: true, // SFX 1 with continuation flags stripped
		stavets: true, // SFX 1, then its continuation into SFX 34
		staves: true, // SFX 34
		coituum: true, // word before the malformed line still loaded
		thtis: false, // a genuine misspelling is still caught
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

test("the original ASCII flag format still works", () => {
	const gs = speller(
		"SET UTF-8\n\nSFX A N 1\nSFX A 0 s .\n\nSFX B N 1\nSFX B 0 ed .\n",
		"1\ntest/AB\n",
	);
	for (const [word, want] of Object.entries({
		test: true,
		tests: true,
		tested: true,
		testing: false,
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

// A dictionary that enables affix-flag compounding accepts words that split
// into flagged dictionary segments, as German "Funktionswert" does.
test("compound segmentation follows COMPOUNDFLAG", () => {
	const dic = "3\nfoo/A\nbar/A\nbaz\n";

	const gs = speller("SET UTF-8\nCOMPOUNDFLAG A\nCOMPOUNDMIN 2\n", dic);
	expect(gs.spell("foobar")).toBe(true);
	expect(gs.spell("fooqux")).toBe(false); // qux is not a word
	expect(gs.spell("foobaz")).toBe(false); // baz has no compound flag

	// Without compound flags, no segmentation happens (English behavior).
	expect(speller("SET UTF-8\n", dic).spell("foobar")).toBe(false);
});

// OpenTaal's Dutch dictionary writes affix rules without the optional
// condition field. A four-field rule must not be mistaken for a header.
test("an affix rule may omit its condition", () => {
	const gs = speller(
		"SET UTF-8\nFLAG long\nSFX Xx Y 1\nSFX Xx 0 s\n",
		"1\nkat/Xx\n",
	);
	expect(gs.spell("kat")).toBe(true);
	expect(gs.spell("kats")).toBe(true);
});

// Nothing in the format forbids an affix class that continues to itself, and
// following it faithfully would not terminate, so expansion is bounded. The
// point is that loading finishes at all and still recognizes the forms the
// bound does allow.
test("a self-continuing affix class terminates", () => {
	const gs = speller(
		"SET UTF-8\nFLAG num\n\nSFX 1 Y 1\nSFX 1 0 s/1 .\n",
		"1\nloop/1\n",
	);
	expect(gs.spell("loop")).toBe(true);
	expect(gs.spell("loops")).toBe(true);
});

test("COMPOUNDMIN is bounded", () => {
	const cases: Record<string, number> = {
		"COMPOUNDMIN 4": 4,
		"COMPOUNDMIN 1": 1,
		"COMPOUNDMIN 0": defaultCompoundMin,
		"COMPOUNDMIN -1": defaultCompoundMin,
		"COMPOUNDMIN 9223372036854775807": defaultCompoundMin,
	};
	for (const [line, want] of Object.entries(cases)) {
		expect(newDictConfig(line).compoundMin, line).toBe(want);
	}
});

test("a COMPOUNDMIN too large to represent is refused", () => {
	for (const line of ["COMPOUNDMIN 99999999999999999999", "COMPOUNDMIN four"]) {
		expect(() => newDictConfig(line), line).toThrow();
	}
});

// A COMPOUNDRULE count only sizes the list, so a wild one must not be able to
// ask for an enormous allocation -- here, it must simply be read as a count.
test("a COMPOUNDRULE count is read as a count", () => {
	const aff = newDictConfig("COMPOUNDRULE 9223372036854775807");
	expect(aff.compoundRule).toEqual([]);
});

test("BREAK rules let a word pass when each piece does", () => {
	const dic = "2\nfoo\nbar\n";

	const plain = speller("SET UTF-8\nBREAK 1\nBREAK -\nWORDCHARS -\n", dic);
	for (const [word, want] of Object.entries({
		"foo-bar": true,
		"foo-bar-foo": true, // split more than once
		"foo-qux": false,
		"qux-bar": false,
		"-foo": false, // an interior rule needs both sides
		"foo-": false,
		"foo--bar": false,
	})) {
		expect(plain.spell(word), word).toBe(want);
	}

	const anchored = speller("SET UTF-8\nBREAK 2\nBREAK ^-\nBREAK -$\n", dic);
	for (const [word, want] of Object.entries({
		"-foo": true,
		"foo-": true,
		"-foo-": true,
		"foo-bar": false, // no interior rule
		"-": false,
	})) {
		expect(anchored.spell(word), word).toBe(want);
	}

	// No BREAK line means Hunspell's defaults: `-`, `^-` and `-$`.
	const defaults = speller("SET UTF-8\n", dic);
	for (const [word, want] of Object.entries({
		"foo-bar": true,
		"-foo": true,
		"foo-": true,
		"foo-qux": false,
		"-": false,
	})) {
		expect(defaults.spell(word), word).toBe(want);
	}

	// `BREAK 0` declares that there are none.
	expect(speller("SET UTF-8\nBREAK 0\n", dic).spell("foo-bar")).toBe(false);
});

test("BREAK parsing treats only the first number as a count", () => {
	const cases: Record<string, string[]> = {
		"BREAK 0": [],
		"BREAK 2\nBREAK -\nBREAK ^-": ["-", "^-"],
		"BREAK -\nBREAK --": ["-", "--"], // the count is optional
		"BREAK 1\nBREAK 3": ["3"],
	};
	for (const [src, want] of Object.entries(cases)) {
		expect(newDictConfig(src).breakPatterns, src).toEqual(want);
	}
	expect(() => newDictConfig("BREAK")).toThrow();
});

// A directive the reader does not implement is recorded once, so a caller can
// tell a dictionary that loaded from one that loaded faithfully.
test("unsupported directives are recorded", () => {
	const aff = newDictConfig(`# a comment line
SET UTF-8
COMPLEXPREFIXES
MAP 2
MAP uü
COMPLEXPREFIXES
TRY esianrtolcdugmphbyfvkwzESIANRTOLCDUGMPHBYFVKWZ'

SFX A Y 1
SFX A 0 s .
`);
	expect(aff.ignored).toEqual(["COMPLEXPREFIXES", "MAP"]);
});

test("TRY, WORDCHARS, ICONV and REP are read", () => {
	const aff = newDictConfig(`SET UTF-8
TRY esia
WORDCHARS 0123456789
ICONV 2
ICONV ’ '
ICONV ‘ '
REP 2
REP f ph
REP alot a_lot
MAP 1
MAP uü
KEY qwerty|asdf
MAXNGRAMSUGS 0
`);
	expect(aff.tryChars).toBe("esia");
	expect(aff.wordChars).toBe("0123456789");
	expect(aff.iconvReplacements).toEqual(["’", "'", "‘", "'"]);
	expect(aff.replacements).toEqual([
		["f", "ph"],
		["alot", "a_lot"],
	]);
	// MAP, KEY and MAXNGRAMSUGS are read by Hunspell and not by this reader,
	// which records them so a caller can tell how faithfully it loaded.
	expect(aff.ignored).toEqual(["MAP", "KEY", "MAXNGRAMSUGS"]);
});

test("PFX and SFX cross-product builds both halves", () => {
	// A cross-product prefix and suffix combine; a non-cross-product one does
	// not pair with anything.
	const gs = speller(
		`SET UTF-8
PFX P Y 1
PFX P 0 un .
SFX S Y 1
SFX S 0 ed .
SFX N N 1
SFX N 0 ly .
`,
		"1\nlock/PSN\n",
	);
	for (const [word, want] of Object.entries({
		lock: true,
		unlock: true,
		locked: true,
		unlocked: true,
		lockly: true,
		unlockly: false, // N is not a cross-product class
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

test("an affix condition is matched against the base word", () => {
	const gs = speller(
		`SET UTF-8
SFX S Y 4
SFX S y ies [^aeiou]y
SFX S 0 s [aeiou]y
SFX S 0 es [sxzh]
SFX S 0 s [^sxzhy]
`,
		"3\ncity/S\nday/S\nbox/S\n",
	);
	for (const [word, want] of Object.entries({
		cities: true,
		citys: false,
		days: true,
		daies: false,
		boxes: true,
		boxs: false,
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

test("a hyphen inside an affix condition is a literal", () => {
	// `[a-c]` is the three literals a, - and c, never the range a through c.
	const gs = speller(
		"SET UTF-8\nSFX S Y 1\nSFX S 0 s [a-c]\n",
		"3\nfooa/S\nfoob/S\nfoo-/S\n",
	);
	expect(gs.spell("fooas")).toBe(true);
	expect(gs.spell("foo-s")).toBe(true);
	expect(gs.spell("foobs")).toBe(false); // b is inside the range, not the class
});
