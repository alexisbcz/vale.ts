import { describe, expect, test } from "bun:test";
import {
	allNonLetter,
	decodeLastRune,
	decodeRune,
	endsWithAny,
	fields,
	hasAnyPrefix,
	hasAnySuffix,
	isDigit,
	isLetter,
	isLower,
	isNumber,
	isSpace,
	isUpper,
	strLen,
	trimSpace,
	utf8Len,
} from "../src/util.ts";

describe("character classes", () => {
	test("whitespace is Go's set, not JavaScript's", () => {
		// U+0085 is whitespace to Go and not to `\s`; U+FEFF is the other way
		// round. A tokenizer that got this wrong would split differently.
		expect(isSpace("\u0085")).toBe(true);
		expect(isSpace("﻿")).toBe(false);
		expect(isSpace(" ")).toBe(true);
		expect(isSpace("　")).toBe(true);
		expect(isSpace("a")).toBe(false);
	});

	test("letters, digits and numbers", () => {
		expect(isLetter("a")).toBe(true);
		expect(isLetter("é")).toBe(true);
		expect(isLetter("1")).toBe(false);
		expect(isDigit("5")).toBe(true);
		expect(isDigit("Ⅴ")).toBe(false); // Roman numeral five is Nl, not Nd
		expect(isNumber("Ⅴ")).toBe(true);
	});

	test("case", () => {
		expect(isUpper("A")).toBe(true);
		expect(isUpper("a")).toBe(false);
		expect(isLower("é")).toBe(true);
		expect(isLower("1")).toBe(false);
	});
});

describe("lengths", () => {
	test("strLen counts code points, as Go counts runes", () => {
		expect(strLen("")).toBe(0);
		expect(strLen("abc")).toBe(3);
		expect(strLen("café")).toBe(4);
		expect(strLen("\u{1f389}")).toBe(1);
		expect(strLen("a\u{1f389}b")).toBe(3);
	});

	test("utf8Len counts the bytes Go's len would", () => {
		expect(utf8Len("abc")).toBe(3);
		expect(utf8Len("café")).toBe(5);
		expect(utf8Len("　")).toBe(3);
		expect(utf8Len("\u{1f389}")).toBe(4);
	});
});

describe("rune decoding", () => {
	test("decodeRune reports the code point and its width", () => {
		expect(decodeRune("abc", 0)).toEqual([0x61, 1]);
		expect(decodeRune("\u{1f389}", 0)).toEqual([0x1f389, 2]);
		expect(decodeRune("abc", 3)).toEqual([0, 0]);
		expect(decodeRune("abc", -1)).toEqual([0, 0]);
	});

	test("decodeLastRune walks backwards over a surrogate pair", () => {
		const s = "a\u{1f389}";
		expect(decodeLastRune(s, s.length)).toEqual([0x1f389, 2]);
		expect(decodeLastRune(s, 1)).toEqual([0x61, 1]);
		expect(decodeLastRune(s, 0)).toEqual([0, 0]);
	});
});

describe("trimSpace", () => {
	test("trims Go's whitespace set", () => {
		expect(trimSpace("  hi \t\n")).toBe("hi");
		expect(trimSpace("\u0085hi\u0085")).toBe("hi");
		expect(trimSpace("")).toBe("");
		expect(trimSpace("   ")).toBe("");
	});

	test("keeps a byte-order mark, which Go does not trim", () => {
		expect(trimSpace("﻿hi")).toBe("﻿hi");
	});
});

describe("fields", () => {
	test("splits on runs of whitespace", () => {
		expect(fields("  a  b\tc\nd ")).toEqual(["a", "b", "c", "d"]);
		expect(fields("")).toEqual([]);
		expect(fields("   ")).toEqual([]);
		expect(fields("one")).toEqual(["one"]);
	});
});

describe("affix tests", () => {
	test("hasAnyPrefix and hasAnySuffix need the string to be longer", () => {
		// Without the length test, stripping an affix off a string that *is*
		// the affix would never shorten it.
		expect(hasAnyPrefix("$100", ["$"])).toBe(true);
		expect(hasAnyPrefix("$", ["$"])).toBe(false);
		expect(hasAnySuffix("Well)", [")"])).toBe(true);
		expect(hasAnySuffix(")", [")"])).toBe(false);
	});

	test("endsWithAny has no length test", () => {
		expect(endsWithAny("es", ["es"])).toBe(true);
		expect(endsWithAny("walked", ["es", "ed", "ing"])).toBe(true);
		expect(endsWithAny("walk", ["es", "ed", "ing"])).toBe(false);
	});
});

describe("allNonLetter", () => {
	test("is true only when nothing is a letter", () => {
		expect(allNonLetter("123!")).toBe(true);
		expect(allNonLetter("")).toBe(true);
		expect(allNonLetter("1a")).toBe(false);
		expect(allNonLetter("é")).toBe(false);
	});
});
