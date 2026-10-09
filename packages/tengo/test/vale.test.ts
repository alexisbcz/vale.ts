/**
 * The programs Vale actually ships, run the way Vale runs them.
 *
 * These are the acceptance tests for the package: a `script` rule's `matches`,
 * a `suggest` action's `suggestions`, and a `metric` rule's formula and
 * condition. The fixtures are copies of the files in Vale's `testdata`.
 */

import { describe, expect, test } from "bun:test";

import {
	addRound,
	describeSource,
	METRIC_BOILERPLATE,
	Script,
} from "../src/index.ts";
import {
	blockScalar,
	fixture,
	runAction,
	runScriptRule,
	scalar,
} from "./helpers.ts";

/** A document with a heading, five paragraphs and a fenced code block. */
const DOCUMENT = [
	"# Heading",
	"",
	"One.",
	"",
	"Two.",
	"",
	"Three.",
	"",
	"Four.",
	"",
	"```go",
	"x := 1",
	"```",
	"",
	"Five.",
	"",
	"## Next",
	"",
	"Body.",
	"",
].join("\n");

interface Match {
	begin: number;
	end: number;
	message?: string;
}

function asMatches(value: unknown): Match[] {
	return value as Match[];
}

describe("script rules", () => {
	test("config/scripts/NewSection.tengo", () => {
		const matches = asMatches(runScriptRule(fixture("NewSection.tengo"), DOCUMENT));
		// The shipped file is a cut-down demo: it strips the code blocks and
		// then appends one fixed match.
		expect(matches).toEqual([{ begin: 1, end: 2, message: "Some message" }]);
	});

	test("styles/Scripts/Test.yml", () => {
		const source = blockScalar(fixture("Scripts-Test.yml"), "script");
		const matches = asMatches(runScriptRule(source, DOCUMENT));

		expect(matches.length).toBe(1);
		const [only] = matches;
		// Every offset indexes the scope the rule was handed, so a match can be
		// sliced straight back out of it.
		expect(DOCUMENT.slice(only!.begin, only!.end)).toBe("Four.");
		expect(only!.message).toBeUndefined();
	});

	test("styles/Checks/ScriptRE.yml, which also strips front matter", () => {
		const source = blockScalar(fixture("Checks-ScriptRE.yml"), "script");
		const scope = `---\ntitle: Example\n---\n${DOCUMENT}`;
		const matches = asMatches(runScriptRule(source, scope));

		expect(matches.length).toBe(1);
		expect(scope.slice(matches[0]!.begin, matches[0]!.end)).toBe("Four.");
	});

	test("testsuite/styles/Ext/Script.yml, both of its own cases", () => {
		const source = blockScalar(fixture("Ext-Script.yml"), "script");

		// The `fires` case from the rule's own `tests:` block.
		const fires = asMatches(runScriptRule(source, "lowercase start.\n"));
		expect(fires).toEqual([{ begin: 0, end: 1 }]);

		// The `clean` case.
		expect(asMatches(runScriptRule(source, "Uppercase start.\n"))).toEqual([]);
	});

	test("a script rule's matches are plain integral offsets", () => {
		const source = blockScalar(fixture("Ext-Script.yml"), "script");
		const matches = asMatches(runScriptRule(source, "one\nTwo\nthree\n"));
		expect(matches.length).toBe(2);
		for (const match of matches) {
			expect(Number.isInteger(match.begin)).toBe(true);
			expect(Number.isInteger(match.end)).toBe(true);
		}
	});

	test("a rule compiled once can be run against block after block", () => {
		const source = blockScalar(fixture("Ext-Script.yml"), "script");
		const script = Script.compile(source, {
			modules: ["text", "fmt", "math"],
		});
		script.add("scope", "");

		for (const [scope, expected] of [
			["lower\n", 1],
			["Upper\n", 0],
			["a\nb\n", 2],
		] as const) {
			const compiled = script.clone();
			compiled.set("scope", scope);
			compiled.run();
			expect(asMatches(compiled.get("matches")).length).toBe(expected);
		}
	});
});

describe("suggest actions", () => {
	test("config/actions/CamelToSnake.tengo", () => {
		const source = fixture("CamelToSnake.tengo");
		expect(runAction(source, "CamelToSnake")).toEqual(["camelto_snake"]);
		expect(runAction(source, "HTTPServerHandler")).toEqual(["httpserver_handler"]);
		// With nothing for the pattern to split on, the action still lower-cases.
		expect(runAction(source, "plain")).toEqual(["plain"]);
	});
});

/** The metric variables a mid-sized document would produce. */
const VARIABLES: Record<string, number> = {
	characters: 500,
	words: 100,
	sentences: 10,
	syllables: 160,
	complex_words: 12,
	long_words: 20,
	polysyllabic_words: 8,
};

/**
 * Evaluates one expression the way Vale's `evalMath` does: inside the
 * boilerplate, with the metric variables and `round` added as globals.
 */
function evalMath(
	expression: string,
	variables: Record<string, number> = VARIABLES,
): unknown {
	const trimmed = expression.trim();
	const shape = describeSource(trimmed);
	expect(shape.statements).toBe(1);
	expect(shape.firstIsExpression).toBe(true);

	const script = Script.compile(METRIC_BOILERPLATE.replace("%s", trimmed), {
		modules: ["math"],
	});
	for (const [name, value] of Object.entries(variables)) {
		script.add(name, value);
	}
	addRound(script);

	const compiled = script.clone();
	compiled.run();
	return compiled.get("__res__");
}

describe("metric formulas", () => {
	const expected: Record<string, [number, boolean]> = {
		// [score, whether the condition holds for VARIABLES]
		AutomatedReadability: [7.12, false],
		ColemanLiau: [10.64, true],
		FleschKincaid: [7.19, false],
		FleschReadingEase: [61.325, true],
		GunningFog: [8.8, false],
		LIX: [30, false],
		SMOG: [8.2387, false],
	};

	for (const [name, [score, holds]] of Object.entries(expected)) {
		test(`styles/Readability/${name}.yml`, () => {
			const yaml = fixture(`Readability/${name}.yml`);
			const formula = blockScalar(yaml, "formula");
			const condition = scalar(yaml, "condition");

			const result = evalMath(formula) as number;
			expect(typeof result).toBe("number");
			expect(result).toBeCloseTo(score, 3);

			// Vale builds the condition by printing the result with `%f` and
			// appending the comparison, then evaluating that as an expression.
			const match = evalMath(`${result.toFixed(6)} ${condition}`, {
				...VARIABLES,
				result,
			});
			expect(match).toBe(holds);
		});
	}

	test("the formulas divide as floats, not as ints", () => {
		// `words / sentences` with int division would be 10 rather than 10.5,
		// and every grade would come out wrong.
		expect(
			evalMath("words / sentences", { words: 105, sentences: 10 }),
		).toBeCloseTo(10.5, 10);
	});

	test("a condition can also weigh the result against a count", () => {
		const result = 12;
		expect(
			evalMath("12.000000 >= 10 && result < 14", { ...VARIABLES, result }),
		).toBe(true);
		expect(
			evalMath("12.000000 >= 10 && result < 12", { ...VARIABLES, result }),
		).toBe(false);
	});

	test("a missing variable reads as 0.0, as Vale sets it", () => {
		expect(evalMath("heading_h1 + 1", { heading_h1: 0 })).toBe(1);
	});
});

describe("the round function Vale injects", () => {
	test("rounds to a whole number by default", () => {
		expect(evalMath("round(3.4)")).toBe(3);
		expect(evalMath("round(3.5)")).toBe(4);
		// Go's math.Round goes away from zero on a tie.
		expect(evalMath("round(-3.5)")).toBe(-4);
		expect(evalMath("round(2.5)")).toBe(3);
	});

	test("takes a number of decimal places", () => {
		expect(evalMath("round(3.14159, 2)")).toBeCloseTo(3.14, 10);
		expect(evalMath("round(3.14159, 4)")).toBeCloseTo(31416 / 1e4, 10);
		expect(evalMath("round(1234.5, -2)")).toBeCloseTo(1200, 10);
	});

	test("always returns a float, so later arithmetic stays floating point", () => {
		expect(evalMath("round(7.0) / 2")).toBe(3.5);
		expect(evalMath("is_float(round(1.0))")).toBe(true);
	});

	test("takes an int as readily as a float", () => {
		expect(evalMath("round(words)")).toBe(100);
	});

	test("the argument count is checked", () => {
		expect(() => evalMath("round()")).toThrow();
		expect(() => evalMath("round(1.0, 2, 3)")).toThrow();
	});
});
