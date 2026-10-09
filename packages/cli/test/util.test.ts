/**
 * JSON written the way Go writes it, which is what the machine-readable
 * commands promise their callers.
 */

import { describe, expect, test } from "bun:test";
import { asMap, getJSON, goJSON, pluralize } from "../src/util.ts";

describe("goJSON", () => {
	test("a struct keeps its declared order", () => {
		expect(goJSON({ b: 1, a: 2 }, "  ")).toBe('{\n  "b": 1,\n  "a": 2\n}');
	});

	test("a map's keys are sorted", () => {
		expect(goJSON(asMap({ b: 1, a: 2 }), "  ")).toBe('{\n  "a": 2,\n  "b": 1\n}');
	});

	test("the three HTML characters are escaped", () => {
		expect(goJSON("<b> & </b>", "")).toBe(
			'"\\u003cb\\u003e \\u0026 \\u003c/b\\u003e"',
		);
	});

	test("control characters and quotes", () => {
		expect(goJSON('a"b\\c\nd\te', "")).toBe('"a\\"b\\\\c\\nd\\te"');
		expect(goJSON("\u0001", "")).toBe('"\\u0001"');
	});

	test("an empty list is [] and a missing value is null", () => {
		expect(goJSON([], "  ")).toBe("[]");
		expect(goJSON(null, "  ")).toBe("null");
		expect(goJSON(undefined, "  ")).toBe("null");
	});

	test("an empty object is {}", () => {
		expect(goJSON({}, "  ")).toBe("{}");
		expect(goJSON(asMap({}), "  ")).toBe("{}");
	});

	test("nesting is indented one level at a time", () => {
		expect(goJSON({ a: [1, { b: 2 }] }, "  ")).toBe(`{
  "a": [
    1,
    {
      "b": 2
    }
  ]
}`);
	});

	test("getJSON is the two-space form", () => {
		expect(getJSON({ a: 1 })).toBe('{\n  "a": 1\n}');
	});

	test("integers keep no decimal point", () => {
		expect(goJSON({ a: 3, b: 3.5 }, "")).toBe('{\n"a": 3,\n"b": 3.5\n}');
	});
});

describe("pluralize", () => {
	test("only one of something keeps the singular", () => {
		expect(pluralize("file", 1)).toBe("file");
		expect(pluralize("file", 0)).toBe("files");
		expect(pluralize("file", 2)).toBe("files");
	});
});
