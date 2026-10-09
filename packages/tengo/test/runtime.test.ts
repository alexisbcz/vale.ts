import { describe, expect, test } from "bun:test";

import {
	Compiled,
	describeSource,
	MODULE_NAMES,
	Script,
	TengoError,
	TengoTimeout,
} from "../src/index.ts";
import { evaluate, runFor } from "./helpers.ts";

describe("the timeout", () => {
	test("a loop with no way out ends as a TengoTimeout", () => {
		const compiled = Script.compile("for {}").clone();
		const started = Date.now();
		expect(() => compiled.run({ timeoutMs: 50 })).toThrow(TengoTimeout);
		// The point of sampling the clock inside the loop rather than between
		// statements: the body is empty, and it still stops promptly.
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("every loop form is interruptible", () => {
		for (const source of [
			"for {}",
			"for true {}",
			"for i := 0; ; i++ {}",
			"a := [1]\nfor { for v in a {} }",
		]) {
			const compiled = Script.compile(source).clone();
			expect(() => compiled.run({ timeoutMs: 30 })).toThrow(TengoTimeout);
		}
	});

	test("endless recursion is interruptible too", () => {
		const compiled = Script.compile(
			"f := func(n) { return f(n) }\nf(1)",
		).clone();
		expect(() => compiled.run({ timeoutMs: 30 })).toThrow(TengoError);
	});

	test("a TengoTimeout is a TengoError", () => {
		const compiled = Script.compile("for {}").clone();
		expect(() => compiled.run({ timeoutMs: 20 })).toThrow(TengoError);
	});

	test("a program that finishes is not interrupted", () => {
		const compiled = Script.compile(
			"out := 0\nfor i := 0; i < 100000; i++ { out += i }",
		).clone();
		compiled.run({ timeoutMs: 2000 });
		expect(compiled.get("out")).toBe(4999950000);
	});
});

describe("modules", () => {
	test("os is not available", () => {
		expect(() => Script.compile('os := import("os")')).toThrow(TengoError);
		expect(() => Script.compile('os := import("os")')).toThrow(
			/module 'os' not found/,
		);
		expect(MODULE_NAMES).not.toContain("os");
	});

	test("the import is resolved when the program is compiled", () => {
		// A rule that asks for a module it cannot have should fail when the
		// style is loaded, not part-way through a lint.
		expect(() =>
			Script.compile('if false { x := import("os") }'),
		).toThrow(TengoError);
	});

	test("the available set can be narrowed", () => {
		expect(() =>
			Script.compile('text := import("text")', { modules: ["math"] }),
		).toThrow(TengoError);
		expect(() =>
			Script.compile('math := import("math")', { modules: ["math"] }),
		).not.toThrow();
	});

	test("the default set is what Vale allows, and no more", () => {
		expect([...MODULE_NAMES].sort()).toEqual(["fmt", "math", "text"]);
	});

	test("a module that does not exist is reported by name", () => {
		expect(() => Script.compile('x := import("nope")')).toThrow(
			/module 'nope' not found/,
		);
	});
});

describe("Script and Compiled", () => {
	test("compiling is separate from running, and globals are not shared", () => {
		const script = Script.compile("out := scope + scope");
		script.add("scope", "");

		const first = script.clone();
		first.set("scope", "a");
		first.run();

		const second = script.clone();
		second.set("scope", "b");
		second.run();

		expect(first.get("out")).toBe("aa");
		expect(second.get("out")).toBe("bb");
	});

	test("a clone can be run more than once", () => {
		const script = Script.compile("n := 0\nn++");
		const compiled = script.clone();
		compiled.run();
		compiled.run();
		expect(compiled.get("n")).toBe(1);
	});

	test("setting a global that was never declared is an error", () => {
		const compiled = Script.compile("out := 1").clone();
		expect(() => compiled.set("nope", 1)).toThrow(TengoError);
	});

	test("reading a global that does not exist gives undefined", () => {
		const compiled = Script.compile("out := 1").clone();
		compiled.run();
		expect(compiled.get("missing")).toBeUndefined();
	});

	test("clone returns a Compiled", () => {
		expect(Script.compile("a := 1").clone()).toBeInstanceOf(Compiled);
	});

	test("names lists what the run left behind", () => {
		const script = Script.compile("b := 2");
		script.add("a", 1);
		const compiled = script.clone();
		compiled.run();
		expect(compiled.names().sort()).toEqual(["a", "b"]);
	});
});

describe("the value boundary", () => {
	test("a JavaScript number arrives as a float", () => {
		// Go reads the static type to choose; JavaScript has only one number,
		// so float is the choice -- which is what every metric formula needs.
		expect(runFor("out := is_float(n)", "out", { n: 3 })).toBe(true);
		expect(runFor("out := n / 2", "out", { n: 3 })).toBe(1.5);
	});

	test("a bigint arrives as an int", () => {
		expect(runFor("out := is_int(n)", "out", { n: 3n })).toBe(true);
		expect(runFor("out := n / 2", "out", { n: 7n })).toBe(3);
	});

	test("the other plain types round-trip", () => {
		expect(runFor("out := s", "out", { s: "hi" })).toBe("hi");
		expect(runFor("out := b", "out", { b: true })).toBe(true);
		expect(runFor("out := a", "out", { a: [1, "x"] })).toEqual([1, "x"]);
		expect(runFor("out := m.k", "out", { m: { k: "v" } })).toBe("v");
		expect(runFor("out := is_undefined(u)", "out", { u: null })).toBe(true);
	});

	test("a map comes back as a plain object and an array as an Array", () => {
		expect(runFor('out := {a: 1, b: [2]}', "out")).toEqual({ a: 1, b: [2] });
		expect(Array.isArray(runFor("out := [1]", "out"))).toBe(true);
	});

	test("an int comes back integral and a float keeps its fraction", () => {
		expect(runFor("out := 10 / 4", "out")).toBe(2);
		expect(runFor("out := 10.0 / 4", "out")).toBe(2.5);
	});

	test("a host function can be called from the program", () => {
		const out = runFor("out := double(21)", "out", {
			double: (n: number) => n * 2,
		});
		expect(out).toBe(42);
	});

	test("a function the program defined comes back callable", () => {
		const out = runFor("out := func(a, b) { return a + b }", "out");
		expect(typeof out).toBe("function");
		expect((out as (a: number, b: number) => number)(1, 2)).toBe(3);
	});
});

describe("describeSource", () => {
	test("a readability formula is one expression", () => {
		expect(
			describeSource(
				"(4.71 * (characters / words)) + (0.5 * (words / sentences)) - 21.43",
			),
		).toEqual({ statements: 1, firstIsExpression: true });
	});

	test("a metric condition, once the result is substituted, is too", () => {
		expect(describeSource("11.979248 > 10")).toEqual({
			statements: 1,
			firstIsExpression: true,
		});
	});

	test("something that is not a single expression is reported as such", () => {
		expect(describeSource("1; 2").statements).toBe(2);
		expect(describeSource("a := 1").firstIsExpression).toBe(false);
		expect(describeSource("if true {}").firstIsExpression).toBe(false);
		expect(describeSource("").statements).toBe(0);
	});

	test("blank lines do not count as statements", () => {
		expect(describeSource("\n\n1\n\n").statements).toBe(1);
	});

	test("a value that cannot be parsed is an error, not a count", () => {
		// `1) + (2` is the shape a formula has to be rejected for: substituted
		// into the boilerplate it would parse, and mean something else.
		expect(() => describeSource("1) + (2")).toThrow(TengoError);
	});
});

describe("errors", () => {
	test("a syntax error names the line", () => {
		expect(() => Script.compile("a := 1\nb := ")).toThrow(/^2: /);
		expect(() => Script.compile("a := (1")).toThrow(TengoError);
		expect(() => Script.compile("a := 'unterminated")).toThrow(TengoError);
		expect(() => Script.compile('a := "unterminated')).toThrow(TengoError);
		expect(() => Script.compile("/* unterminated")).toThrow(TengoError);
	});

	test("an unknown name is an error rather than undefined", () => {
		expect(() => evaluate("nope")).toThrow(/unresolved reference 'nope'/);
	});

	test("an illegal character is reported", () => {
		expect(() => Script.compile("a := #")).toThrow(TengoError);
	});

	test("a runtime error carries the operation that failed", () => {
		expect(() => evaluate("{} + 1")).toThrow(/invalid operation/);
		expect(() => evaluate('[1][  "a"]')).toThrow(/invalid index type/);
	});
});
