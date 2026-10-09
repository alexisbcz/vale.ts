import { describe, expect, test } from "bun:test";
import { ValeError } from "@vale-ts/core";
import {
	checkExpression,
	evalMath,
	measuredScope,
	Metric,
	round,
	ruleError,
	TENGO_TIMEOUT_MS,
} from "../src/index.ts";
import { testConfig } from "./helpers.ts";
import { tengoAvailable } from "./tengo.ts";

test("a measuring rule measures the summary unless told otherwise", () => {
	expect(measuredScope([])).toEqual(["summary"]);
	expect(measuredScope(["text"])).toEqual(["summary"]);
	expect(measuredScope(["paragraph", "list"])).toEqual(["paragraph", "list"]);
});

test("a heading variable is spelled with an underscore", () => {
	const rule = new Metric(
		testConfig(),
		{
			extends: "metric",
			name: "Test.Headings",
			level: "warning",
			message: "%s",
			formula: "heading.h2 + heading.h3",
			condition: "> 2",
		},
		"Test.Headings",
	);
	expect(rule.pattern()).toBe("heading_h2 + heading_h3");
	expect(rule.fields().scope).toEqual(["summary"]);
});

describe("round", () => {
	// The standard library has floor, ceil and trunc but not this, and a grade
	// is reported rounded. Halves go away from zero, as Go's `math.Round` does.
	const cases: Array<[unknown[], number]> = [
		[[9.456], 9],
		[[9.456, 1], 9.5],
		[[9.456, 2], 9.46],
		[[2.5], 3],
		[[-2.5], -3],
		[[0], 0],
	];

	for (const [args, want] of cases) {
		test(JSON.stringify(args), () => {
			expect(round(...args)).toBe(want);
		});
	}

	for (const args of [[], [1, 2, 3], ["x"], [1, "x"]]) {
		test(`refuses ${JSON.stringify(args)}`, () => {
			expect(() => round(...args)).toThrow();
		});
	}
});

test("a runtime failure is reported against the rule", () => {
	const err = ruleError(
		"Runaway.Loop",
		"script",
		"/nonexistent/Runaway.yml",
		new Error("whatever"),
		true,
	);
	expect(err).toBeInstanceOf(ValeError);
	expect(err.msg).toContain("Runaway.Loop");
	expect(err.msg).toContain("did not finish within");
	expect(TENGO_TIMEOUT_MS).toBeGreaterThan(0);
});

/**
 * A formula is substituted into a larger program, so one carrying its own
 * parentheses could read as several statements. Only a single expression is a
 * formula this rule can evaluate.
 */
describe.skipIf(!tengoAvailable())("evalMath", () => {
	test("a value that is not one expression is refused", () => {
		for (const expr of [
			// Closes the substitution's parenthesis and reopens it, so what
			// arrives is three statements rather than one expression.
			"0); for { } ; x := (0",
			"0); x := 1; y := (0",
			// A statement rather than an expression.
			"x := 1",
		]) {
			let message = "";
			try {
				evalMath(Date.now() + TENGO_TIMEOUT_MS, expr, {});
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).not.toBe("");
			expect(message).not.toContain("did not finish");
		}
	});

	test("the formulas that ship with Vale keep working", () => {
		const params = {
			words: 100,
			sentences: 10,
			syllables: 150,
			long_words: 20,
			polysyllabic_words: 5,
			characters: 500,
		};

		for (const expr of [
			"words / sentences",
			"(words / sentences) + ((long_words * 100) / words)",
			"(0.39 * (words / sentences)) + (11.8 * (syllables / words)) - 15.59",
			"1.0430 * math.sqrt((polysyllabic_words * 30.0) / sentences) + 3.1291",
			// The block-scalar forms arrive with surrounding whitespace.
			"\n  words / sentences\n",
		]) {
			expect(() =>
				evalMath(Date.now() + TENGO_TIMEOUT_MS, expr, params),
			).not.toThrow();
		}
	});

	test("the condition path is guarded the same way", () => {
		// What `Metric.run` builds: the result, then the rule's condition.
		expect(() =>
			evalMath(Date.now() + TENGO_TIMEOUT_MS, "12.500000 > 10", {}),
		).not.toThrow();
		expect(() =>
			evalMath(
				Date.now() + TENGO_TIMEOUT_MS,
				"12.500000 > 0); for { } ; x := (0",
				{},
			),
		).toThrow();
	});

	test("the check happens before evaluation", () => {
		// A formula stopped by the deadline was still evaluated, which is a
		// slower answer and a worse message.
		const start = Date.now();
		expect(() =>
			evalMath(Date.now() + TENGO_TIMEOUT_MS, "0); for { } ; x := (0", {}),
		).toThrow();
		expect(Date.now() - start).toBeLessThan(1000);
	});

	test("`round` is a function of the formula's own", () => {
		const params: Record<string, unknown> = { grade: 9.456, words: 0 };
		const cases: Array<[string, number]> = [
			["round(grade)", 9],
			["round(grade, 1)", 9.5],
			["round(grade, 2)", 9.46],
			["round(2.5)", 3],
			["round(-2.5)", -3],
			["round(words)", 0],
		];
		for (const [expr, want] of cases) {
			expect(evalMath(Date.now() + TENGO_TIMEOUT_MS, expr, params)).toBe(want);
		}
	});

	test("an empty expression is refused", () => {
		expect(() => evalMath(Date.now() + TENGO_TIMEOUT_MS, "   ", {})).toThrow();
	});

	test("checkExpression reads a single expression", () => {
		expect(() => checkExpression("words / sentences")).not.toThrow();
		expect(() => checkExpression("x := 1")).toThrow();
	});
});
