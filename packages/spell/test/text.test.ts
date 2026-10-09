/**
 * The string primitives, where this port departs from JavaScript's own.
 *
 * Simple case mapping is the one that changes what a dictionary accepts, so
 * it is pinned here against the characters whose full mapping differs.
 */

import { expect, test } from "bun:test";

import {
	allDigits,
	capitalize,
	fields,
	lines,
	lowerFirst,
	parseInt64,
	quoteMeta,
	Replacer,
	runeCount,
	toLower,
	toUpper,
	utf8Bytes,
} from "../src/text.ts";
import { isNumber, isNumberUnits, Splitter } from "../src/words.ts";

test("toUpper applies the simple mapping, not the full one", () => {
	// Each of these grows under the full mapping, which Hunspell does not use:
	// CHECKSHARPS exists because ß has no upper-case form of its own.
	expect(toUpper("ß")).toBe("ß");
	expect(toUpper("straße")).toBe("STRAßE");
	expect(toUpper("ﬁ")).toBe("ﬁ");
	// The ordinary mappings are unchanged.
	expect(toUpper("hello")).toBe("HELLO");
	expect(toUpper("ı")).toBe("I");
	expect(toUpper("ǅ")).toBe("Ǆ");
});

test("toLower applies the simple mapping, not the full one", () => {
	// İ lower-cases to a bare i, not to i plus a combining dot.
	expect(toLower("İ")).toBe("i");
	expect(runeCount(toLower("İ"))).toBe(1);
	// A final sigma is not special-cased, since each character maps alone.
	expect(toLower("ΑΣ")).toBe("ασ");
	expect(toLower("HELLO")).toBe("hello");
});

test("capitalize and lowerFirst touch one code point", () => {
	expect(capitalize("hello")).toBe("Hello");
	expect(capitalize("")).toBe("");
	expect(capitalize("ßeta")).toBe("ßeta"); // no simple upper-case form
	expect(lowerFirst("ULinda")).toBe("uLinda");
	// An astral character is one code point.
	expect(capitalize("\u{1F600}x")).toBe("\u{1F600}x");
});

test("lines follows bufio.Scanner", () => {
	expect(lines("a\nb\n")).toEqual(["a", "b"]);
	expect(lines("a\nb")).toEqual(["a", "b"]);
	expect(lines("a\r\nb\r\n")).toEqual(["a", "b"]);
	expect(lines("")).toEqual([]);
	expect(lines("\n")).toEqual([""]);
	expect(lines("a\n\n")).toEqual(["a", ""]);
});

test("fields splits on runs of whitespace", () => {
	expect(fields("  SFX   A  0 s . ")).toEqual(["SFX", "A", "0", "s", "."]);
	expect(fields("word\tpo:noun")).toEqual(["word", "po:noun"]);
	expect(fields("   ")).toEqual([]);
	expect(fields("")).toEqual([]);
});

test("utf8Bytes gives a flag per byte of the file", () => {
	// Hunspell reads a flag out of a UTF-8 file byte by byte, so a two-byte
	// character is two flags.
	expect(utf8Bytes("AB")).toEqual(["A", "B"]);
	expect(utf8Bytes("ğ").length).toBe(2);
	expect(utf8Bytes("ğ").join("")).not.toBe("ğ");
});

test("parseInt64 refuses what strconv.ParseInt refuses", () => {
	expect(parseInt64("4")).toBe(4n);
	expect(parseInt64("-1")).toBe(-1n);
	expect(parseInt64("9223372036854775807")).toBe(9223372036854775807n);
	expect(parseInt64("99999999999999999999")).toBeNull();
	expect(parseInt64("four")).toBeNull();
	expect(parseInt64("")).toBeNull();
	expect(parseInt64("1.5")).toBeNull();
});

test("allDigits is ASCII only", () => {
	expect(allDigits("123")).toBe(true);
	expect(allDigits("")).toBe(false);
	expect(allDigits("1a")).toBe(false);
	expect(allDigits("۱۲۳")).toBe(false);
});

test("quoteMeta escapes what a pattern would read", () => {
	expect(new RegExp(`^${quoteMeta("CI/CD.a+b")}$`).test("CI/CD.a+b")).toBe(true);
	expect(new RegExp(`^${quoteMeta("a.c")}$`).test("abc")).toBe(false);
});

test("Replacer takes the first listed pattern at each position", () => {
	const r = new Replacer([
		["aa", "X"],
		["a", "Y"],
	]);
	expect(r.replace("aaa")).toBe("XY");
	// A replacement is never re-scanned.
	expect(new Replacer([["a", "aa"]]).replace("a")).toBe("aa");
});

test("the word shapes that are not dictionary words", () => {
	expect(isNumber("1,234")).toBe(true);
	expect(isNumber("۱۲۳")).toBe(true);
	expect(isNumber("12a")).toBe(false);
	expect(isNumberUnits("100GB")).toBe("GB");
	expect(isNumberUnits("GB")).toBe("");
});

test("Splitter breaks on anything that is not a word character", () => {
	const s = new Splitter("'-");
	expect(s.split("don't stop -- now!")).toEqual(["don't", "stop", "--", "now"]);
	expect(new Splitter("").split("a1b")).toEqual(["a", "b"]);
});
