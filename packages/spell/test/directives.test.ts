import { expect, test } from "bun:test";

import type { GoSpell } from "../src/index.ts";
import { speller } from "./helpers.ts";

function checkWords(gs: GoSpell, want: Record<string, boolean>): void {
	for (const [word, ok] of Object.entries(want)) {
		expect(gs.spell(word), word).toBe(ok);
	}
}

// A forbidden entry overrides the form another entry's affixes generate.
test("FORBIDDENWORD", () => {
	const gs = speller(
		"FORBIDDENWORD !\nSFX S Y 1\nSFX S 0 s .\n",
		"3\nfoo/S\nfoos/!\nbar/!S\n",
	);
	checkWords(gs, {
		foo: true,
		foos: false,
		Foos: false,
		bar: false,
		bars: false,
	});
});

// A NEEDAFFIX stem is only a word once affixed; PSEUDOROOT is its old name.
test("NEEDAFFIX and PSEUDOROOT", () => {
	for (const directive of ["NEEDAFFIX", "PSEUDOROOT"]) {
		const gs = speller(
			`${directive} X\nSFX S Y 1\nSFX S 0 s .\n`,
			"2\nvirtual/XS\nreal/S\n",
		);
		checkWords(gs, {
			virtual: false,
			virtuals: true,
			real: true,
			reals: true,
		});
	}
});

// A KEEPCASE word is accepted only as written; other words still accept their
// capitalized and upper-cased forms.
test("KEEPCASE", () => {
	const gs = speller(
		"KEEPCASE K\nSFX S Y 1\nSFX S 0 s .\n",
		"2\nmacOS/K\niPhone/KS\n",
	);
	checkWords(gs, {
		macOS: true,
		MacOS: false,
		MACOS: false,
		macos: false,
		iPhone: true,
		iPhones: true,
		IPhones: false,
	});
});

// A CIRCUMFIX prefix and suffix are only valid together; a prefix without the
// flag still pairs with the suffixes that lack it.
test("CIRCUMFIX", () => {
	const gs = speller(
		`CIRCUMFIX C
PFX P Y 2
PFX P 0 ge/C .
PFX P 0 un .
SFX T Y 1
SFX T 0 t/C .
SFX N Y 1
SFX N 0 en .
`,
		"1\nmach/PTN\n",
	);
	checkWords(gs, {
		mach: true,
		machen: true,
		gemacht: true,
		unmach: true,
		unmachen: true,
		gemach: false,
		macht: false,
		gemachen: false,
		unmacht: false,
	});
});

// An AF alias names a flag set by its line number, for entries and for the
// continuation flags an affix rule carries.
test("AF flag aliases", () => {
	const gs = speller(
		`AF 2
AF S
AF ST
SFX S Y 1
SFX S 0 s .
SFX T Y 1
SFX T 0 ed/1 .
`,
		"2\nwalk/2\ndog/1\n",
	);
	checkWords(gs, {
		walk: true,
		walks: true,
		walked: true,
		walkeds: true,
		dog: true,
		dogs: true,
		doged: false,
	});
});

// A zero affix may still carry continuation flags: `0/L` is an unchanged form
// that the prefix L then applies to.
test("a zero affix with continuation flags", () => {
	const gs = speller(
		`SET UTF-8
PFX L Y 1
PFX L 0 l' .
SFX F Y 1
SFX F 0 0/L .
`,
		"1\nordinateur/F\n",
	);
	checkWords(gs, {
		ordinateur: true,
		"l'ordinateur": true,
		ordinateur0: false,
		"l'ordinateur0": false,
	});
});

// A prefix rule strips before it adds: `a l'A a` makes l'Ami from ami.
test("a prefix rule strips before it adds", () => {
	const gs = speller("SET UTF-8\nPFX A N 1\nPFX A a l'A a\n", "1\nami/A\n");
	checkWords(gs, { ami: true, "l'Ami": true, "l'Aami": false });
});

// A word from an ignore list is suggested, ahead of a dictionary word it ties
// with.
test("a listed word is suggested first", () => {
	const gs = speller("SET UTF-8\n", "2\nkubeful\nother\n");
	expect(gs.addWordList("kubectl\n")).toEqual([]);
	expect(gs.suggest("kubctl")[0]).toBe("kubectl");
});

test("a word added twice is reported as a duplicate", () => {
	const gs = speller("SET UTF-8\n", "1\nword\n");
	expect(gs.addWordRaw("kubectl")).toBe(true);
	expect(gs.addWordRaw("kubectl")).toBe(false);
	expect(gs.addWordList("kubectl\n#\n\n  helm  \n")).toEqual(["kubectl"]);
	expect(gs.spell("helm")).toBe(true);
	expect(gs.spell("#")).toBe(false);
});

test("ONLYINCOMPOUND keeps a form out of a word of its own", () => {
	// `th` is only in a compound, which the COMPOUNDRULE builds: 4th, 11th.
	const gs = speller(
		`SET UTF-8
COMPOUNDMIN 1
ONLYINCOMPOUND c
COMPOUNDRULE 1
COMPOUNDRULE n*t
WORDCHARS 0123456789
`,
		"3\n4/t\n1/n\nth/c\n",
	);
	checkWords(gs, { "4": true, "114": true, th: false });
});

test("ICONV rewrites the input before it is checked", () => {
	const gs = speller("SET UTF-8\nICONV 1\nICONV ’ '\n", "1\ndon't\n");
	expect(gs.spell("don’t")).toBe(true);
	expect(gs.inputConversion("don’t")).toBe("don't");
});

test("IGNORE drops its characters from words and from affixes", () => {
	const gs = speller(
		"SET UTF-8\nIGNORE ـ\nSFX S Y 1\nSFX S 0 ـs .\n",
		"1\nfoo/S\n",
	);
	expect(gs.spell("foـo")).toBe(true);
	expect(gs.spell("foos")).toBe(true);
});
