import { expect, test } from "bun:test";

import type { CaseStyle } from "../src/index.ts";
import { classifyCase } from "../src/index.ts";
import { speller } from "./helpers.ts";

// Hunspell accepts the upper-cased form of any entry; a capitalized entry
// still rejects its lower-cased form.
test("the upper-cased form of a capitalized entry", () => {
	const gs = speller("SET UTF-8\n", "2\nParis\nhello\n");
	for (const [word, want] of Object.entries({
		Paris: true,
		PARIS: true,
		paris: false,
		hello: true,
		Hello: true,
		HELLO: true,
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

// A suggestion is returned in the case the word was written in, and an
// apostrophe does not start a new word.
test("suggestions keep the word's case", () => {
	const gs = speller("SET UTF-8\n", "2\ndon't\nworld\n");

	const cases: Record<string, string> = {
		"Don'y": "Don't",
		"DON'Y": "DON'T",
		"don'y": "don't",
		Wrold: "World",
		WROLD: "WORLD",
	};
	for (const [word, want] of Object.entries(cases)) {
		expect(gs.suggest(word)[0], word).toBe(want);
	}

	// Fewer entries than suggestions is not an error.
	expect(gs.suggest("wrold")).toEqual(["world", "don't"]);
});

test("classifyCase matches Hunspell's five classes", () => {
	const cases: Record<string, CaseStyle> = {
		hello: "noCap",
		Hello: "initCap",
		HELLO: "allCap",
		ULinda: "huhInitCap",
		uLinda: "huhCap",
		fOO: "huhCap",
		"42": "noCap",
		"": "noCap",
		"H-E": "allCap",
	};
	for (const [word, want] of Object.entries(cases)) {
		expect(classifyCase(word), word).toBe(want);
	}
});

// A mixed-case word stands only for itself, so folding it never reaches a
// dictionary entry.
test("a mixed-case word is checked as written", () => {
	const gs = speller("SET UTF-8\n", "1\nfoo\n");
	for (const [word, want] of Object.entries({
		foo: true,
		Foo: true,
		FOO: true,
		fOO: false,
		FoO: false,
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

// Under CHECKSHARPS an all-caps word writes ß as SS, which is the only way an
// upper-cased ß word may be spelled.
test("CHECKSHARPS upper-cases ß as SS", () => {
	const gs = speller("SET UTF-8\nCHECKSHARPS\n", "1\nStraße\n");
	for (const [word, want] of Object.entries({
		Straße: true,
		STRASSE: true,
		straße: false,
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

// Turkish keeps the dotted and dotless i apart in both directions.
test("a Turkic LANG folds i and ı separately", () => {
	const gs = speller("SET UTF-8\nLANG tr_TR\n", "2\nkitap\nIşık\n");
	for (const [word, want] of Object.entries({
		kitap: true,
		Kitap: true,
		KİTAP: true,
		KITAP: false, // the dotless I is not the capital of i
		Işık: true,
		IŞIK: true,
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});

// A number, a hex or binary literal, a hash, and a number with a unit are all
// accepted without being in the dictionary.
test("the shapes that are not dictionary words", () => {
	const gs = speller("SET UTF-8\n", "1\nGB\n");
	for (const [word, want] of Object.entries({
		"1,234": true,
		"3.14": true,
		"۱۲۳": true,
		"0x1B": true,
		x12FF: true,
		"0b1011": true,
		"0123456789012345678901234567890123456789": true, // a 40-char hash
		"100GB": true,
		"100QQ": false, // QQ is not a word
	})) {
		expect(gs.spell(word), word).toBe(want);
	}
});
