/**
 * The expression language a conditional section and `--filter` are written in.
 *
 * There is no Go test for this: Go uses `expr-lang/expr`, a library with its
 * own suite. The cases below pin the subset Vale exposes to what that library
 * answers -- the operators and their precedence, `in`, `matches`, `contains`,
 * `startsWith`/`endsWith`, `??`, the predicate builtins with a closure, the
 * scalar builtins -- plus the one deliberate difference: a member that is
 * missing reads as false in a boolean position, which is the patch Vale
 * applies to `expr` so that `not .Meta.draft` holds for a file with no front
 * matter.
 */

import { describe, expect, test } from "bun:test";
import { compileExpr, type Environment, ExprError, truthy } from "../src/expr.ts";

const RULES = [
	{ Name: "Vale.Spelling", Level: "error", Scope: "text", Tags: ["a", "b"] },
	{ Name: "Google.Colons", Level: "warning", Scope: "heading", Tags: [] },
];

const ENV: Environment = {
	Rules: RULES,
	Meta: { tags: ["a", "b"], count: 3, draft: false },
	n: 3,
	s: "Hello",
};

function run(src: string, env: Environment = ENV, item?: unknown): unknown {
	return compileExpr(src).run(env, item);
}

describe("operators", () => {
	const cases: Array<[string, unknown]> = [
		// Arithmetic, and the precedence between the levels.
		["1 + 2 * 3", 7],
		["(1 + 2) * 3", 9],
		["10 - 2 - 3", 5],
		["7 % 4", 3],
		["7 / 2", 3.5],
		["-2 + 1", -1],
		// `**` is the one operator that groups to the right.
		["2 ** 3 ** 2", 512],
		["2 ** 3 * 2", 16],
		// Comparison binds tighter than `and`, which binds tighter than `or`.
		["1 < 2 and 2 < 3", true],
		["true or false and false", true],
		["(true or false) and false", false],
		["1 == 1 and 2 != 3", true],
		["2 >= 2 and 2 <= 2", true],
		// `not` is a unary operator, so it takes only what follows it.
		["not true == false", true],
		["!false", true],
		["not (1 > 2)", true],
		// `+` concatenates when either side is a string.
		['"a" + "b"', "ab"],
		['"n=" + string(3)', "n=3"],
		// Strings compare lexically.
		['"a" < "b"', true],
	];

	test.each(cases)("%s", (src, want) => {
		expect(run(src)).toEqual(want);
	});
});

describe("membership and text operators", () => {
	const cases: Array<[string, unknown]> = [
		['"b" in ["a", "b"]', true],
		['"c" in ["a", "b"]', false],
		// On a map, `in` asks about the keys.
		['"tags" in Meta', true],
		['"x" in Meta', false],
		// On a string, about a substring.
		['"ell" in "hello"', true],
		['"hello" matches "^h.*o$"', true],
		['"hello" matches "^z"', false],
		['"hello" contains "ell"', true],
		['"hello" contains "xyz"', false],
		['"hello" startsWith "he"', true],
		['"hello" startsWith "lo"', false],
		['"hello" endsWith "lo"', true],
		['"hello" endsWith "he"', false],
	];

	test.each(cases)("%s", (src, want) => {
		expect(run(src)).toEqual(want);
	});

	test("an invalid pattern is reported", () => {
		expect(() => run('"a" matches "("')).toThrow(ExprError);
	});
});

describe("??", () => {
	const cases: Array<[string, unknown]> = [
		// Only nil falls through, so a false or a zero is kept.
		["Meta.count ?? 9", 3],
		["Meta.draft ?? true", false],
		["Meta.nope ?? 9", 9],
		["Missing ?? 9", 9],
		['Meta.nope ?? Meta.count ?? "last"', 3],
	];

	test.each(cases)("%s", (src, want) => {
		expect(run(src)).toEqual(want);
	});
});

describe("predicates over a list", () => {
	const cases: Array<[string, unknown]> = [
		['any(Rules, {.Level == "error"})', true],
		['any(Rules, {.Level == "fatal"})', false],
		['all(Rules, {.Name startsWith "V"})', false],
		['all(Rules, {.Name matches "^[A-Z]"})', true],
		['none(Rules, {.Level == "fatal"})', true],
		['none(Rules, {.Level == "error"})', false],
		['one(Rules, {.Level == "error"})', true],
		['one(Rules, {.Name != ""})', false],
		// `filter` and `map` give back lists, so they compose with the rest.
		['len(filter(Rules, {.Level == "error"}))', 1],
		['join(map(Rules, {.Name}), ",")', "Vale.Spelling,Google.Colons"],
		['filter(Rules, {.Scope == "heading"})[0].Name', "Google.Colons"],
		// `#` is the item under consideration, which a leading dot shortens.
		["len(filter(Rules, {len(#.Tags) > 0}))", 1],
	];

	test.each(cases)("%s", (src, want) => {
		expect(run(src)).toEqual(want);
	});

	test("a predicate builtin needs a closure", () => {
		expect(() => run("any(Rules, true)")).toThrow(ExprError);
	});
});

describe("builtins", () => {
	const cases: Array<[string, unknown]> = [
		// `len` counts characters, not code units.
		['len("héllo")', 5],
		["len(Rules)", 2],
		["len(Meta)", 3],
		['lower("ABC")', "abc"],
		['upper("abc")', "ABC"],
		['trim("  a  ")', "a"],
		['trim("xxaxx", "x")', "a"],
		['split("a,b,c", ",")', ["a", "b", "c"]],
		['join(["a", "b"], "-")', "a-b"],
		['int("3.7")', 3],
		["int(3.7)", 3],
		['float("2.5")', 2.5],
		['string(3) + "!"', "3!"],
		["abs(-3)", 3],
		["max(1, 5, 3)", 5],
		["min(1, 5, 3)", 1],
		['hasPrefix("abc", "ab")', true],
		['hasSuffix("abc", "bc")', true],
	];

	test.each(cases)("%s", (src, want) => {
		expect(run(src)).toEqual(want);
	});

	test("an unknown function is reported", () => {
		expect(() => run("nope(1)")).toThrow(ExprError);
	});
});

describe("access", () => {
	const cases: Array<[string, unknown]> = [
		["Rules[0].Name", "Vale.Spelling"],
		// A negative index counts from the end.
		["Rules[-1].Name", "Google.Colons"],
		['Meta["count"]', 3],
		["s[1]", "e"],
		["nil == nil", true],
		['{"a": 1, "b": 2}["b"]', 2],
		["{a: 1}.a", 1],
		["[1, 2, 3][1]", 2],
	];

	test.each(cases)("%s", (src, want) => {
		expect(run(src)).toEqual(want);
	});

	test("a leading dot addresses the item under consideration", () => {
		expect(run(".Name", ENV, RULES[0])).toBe("Vale.Spelling");
		expect(run("#.Name", ENV, RULES[1])).toBe("Google.Colons");
	});
});

/**
 * The one deliberate difference from a general expression language.
 *
 * `.Meta.draft` on a file with no `draft` key is nothing at all, so `not` of
 * it has to be true rather than an error -- the same patch Vale applies to
 * `expr` with `missingIsFalse`.
 */
describe("a missing member reads as false", () => {
	const cases: Array<[string, unknown]> = [
		["not Meta.nope", true],
		["!Meta.nope", true],
		["Meta.nope and true", false],
		["Meta.nope or true", true],
		["Meta.nope == nil", true],
		["Meta.nope != nil", false],
		// Missing all the way down, rather than failing on the way.
		["not Meta.nope.deeper", true],
		["not Missing", true],
		// `in` over a list that is not there finds nothing.
		['"b" in Meta.nope', false],
	];

	test.each(cases)("%s", (src, want) => {
		expect(run(src)).toEqual(want);
	});

	test("runBool reads the result's truthiness", () => {
		expect(compileExpr("Meta.nope").runBool(ENV)).toBe(false);
		expect(compileExpr("Meta.count").runBool(ENV)).toBe(true);
	});
});

describe("truthy", () => {
	test("what counts as true", () => {
		for (const v of [true, 1, -1, "x", [1], {}]) {
			expect(truthy(v), String(v)).toBe(true);
		}
		for (const v of [false, 0, "", [], null, undefined]) {
			expect(truthy(v), String(v)).toBe(false);
		}
	});
});

describe("compileExpr", () => {
	test("reports a syntax error rather than guessing", () => {
		for (const bad of ["1 +", "(1", "a b", '"unterminated', "a..b", "[1,"]) {
			expect(() => compileExpr(bad), bad).toThrow(ExprError);
		}
	});

	/**
	 * `asBool` is Go's `expr.AsBool()`: an expression whose type is known and
	 * is not a boolean cannot be a condition. A type that is *unknown* -- a
	 * member access, which is what `.Meta.draft` is -- is judged at run time.
	 */
	test("asBool refuses an expression that cannot be a condition", () => {
		for (const bad of ['"text"', "1", "[1, 2]", "lower(s)", "len(Rules)"]) {
			expect(() => compileExpr(bad, { asBool: true }), bad).toThrow(ExprError);
		}
		for (const good of [
			".Meta.draft",
			'.Name == "a"',
			"not .Meta.draft",
			'any(Rules, {.Level == "error"})',
			'Meta.nope ?? "x"',
		]) {
			expect(() => compileExpr(good, { asBool: true }), good).not.toThrow();
		}
	});
});
