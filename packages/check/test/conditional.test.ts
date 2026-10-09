import { describe, expect, test } from "bun:test";
import { View } from "@vale-ts/core";
import { Conditional, hasCaptureGroup } from "../src/index.ts";
import { block, testConfig, testFile } from "./helpers.ts";

test("without `in`, the rule reads only its own block", () => {
	const cfg = testConfig();
	const rule = new Conditional(
		cfg,
		{ first: String.raw`\bSection\b`, second: "Summary:" },
		"",
	);

	const f = testFile();
	expect(
		rule.run(block("Section one. Summary: fine.", "text"), f, cfg).length,
	).toBe(0);
	expect(rule.run(block("Section one.", "text"), f, cfg).length).toBe(1);
});

test("an abbreviation defined parenthetically is accepted", () => {
	const cfg = testConfig();
	const rule = new Conditional(
		cfg,
		{
			// `first` is the antecedent -- the abbreviation -- and `second` the
			// consequent that defines it, whose capture group names what was
			// defined.
			first: String.raw`\b[A-Z]{3,5}\b`,
			second: String.raw`(?:\b[A-Z][a-z]+ )+\(([A-Z]{3,5})\)`,
		},
		"",
	);

	const f = testFile();
	expect(
		rule.run(
			block("World Health Organization (WHO) says WHO.", "text"),
			f,
			cfg,
		).length,
	).toBe(0);

	const g = testFile();
	expect(rule.run(block("The WHO says so.", "text"), g, cfg).length).toBe(1);
});

describe("with `in`, the consequent is looked for in another scope", () => {
	function ruleFor(): [Conditional, ReturnType<typeof testConfig>] {
		const cfg = testConfig();
		cfg.views.COMMIT_EDITMSG = new View({
			engine: "dasel",
			scopes: [
				{ name: "subject", expr: "", type: "" },
				{ name: "trailer", expr: "", type: "" },
			],
		});
		const rule = new Conditional(
			cfg,
			{
				scope: "subject",
				first: String.raw`^\w+(?:\([^)]*\))?!:`,
				second: "^BREAKING CHANGE: ",
				in: "trailer",
			},
			"",
		);
		return [rule, cfg];
	}

	const cases: Array<[string, string[] | null, number]> = [
		["footer present", ["BREAKING CHANGE: the flag is gone"], 0],
		["footer absent", ["Signed-off-by: J <j@x.y>"], 1],
		["scope unfilled", [""], 1],
		["scope missing", null, 1],
	];

	for (const [name, trailer, want] of cases) {
		test(name, () => {
			const [rule, cfg] = ruleFor();
			const f = testFile({ scoped: trailer === null ? {} : { trailer } });
			const alerts = rule.run(
				block("feat!: drop the flag", "text.subject"),
				f,
				cfg,
			);
			expect(alerts.length).toBe(want);
		});
	}
});

test("an `in` that no View defines is refused at load", () => {
	expect(
		() =>
			new Conditional(testConfig(), { first: "a", second: "b", in: "nope" }, ""),
	).toThrow();
});

describe("hasCaptureGroup", () => {
	// A `(` inside a character class or behind an escape is not a group.
	// Reading one as a group turned a presence check into a definition check.
	const cases: Array<[string, boolean]> = [
		["(x)", true],
		["(?<name>x)", true],
		["(?P<name>x)", true],
		["(?:x)", false],
		["(?=x)", false],
		["(?<=x)", false],
		["(?<!x)", false],
		["(?i)x", false],
		[String.raw`\(x\)`, false],
		["[(]", false],
		["[^()]", false],
		[String.raw`^\w+(?:\([^()]*\))?!:`, false],
		[String.raw`^\w+(?:\([^)]*\))?!:`, false],
		[String.raw`\[(x)\]`, true],
		[String.raw`[a-z](\d)`, true],
	];

	for (const [pattern, want] of cases) {
		test(pattern, () => {
			expect(hasCaptureGroup(pattern)).toBe(want);
		});
	}
});
