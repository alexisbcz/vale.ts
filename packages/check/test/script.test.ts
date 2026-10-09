import { describe, expect, test } from "bun:test";
import { Block } from "@vale-ts/core";
import { parseMatches, Script, sourceSpan } from "../src/index.ts";
import { testConfig, testFile } from "./helpers.ts";
import { tengoAvailable } from "./tengo.ts";

describe("parseMatches reads what a program left behind", () => {
	test("a well-formed list", () => {
		expect(
			parseMatches([
				{ begin: 0, end: 3 },
				{ begin: 4, end: 7, message: "why" },
			]),
		).toEqual([
			{ begin: 0, end: 3 },
			{ begin: 4, end: 7, message: "why" },
		]);
	});

	test("anything else is nothing", () => {
		expect(parseMatches(null)).toEqual([]);
		expect(parseMatches("nope")).toEqual([]);
		expect(parseMatches([{ begin: "x", end: 1 }, null, 5])).toEqual([]);
	});
});

describe("sourceSpan carries a span of the block to the document", () => {
	test("a block that is its own document needs no translation", () => {
		const blk = new Block("", "hello world", "raw");
		expect(sourceSpan(blk, 0, 5)).toEqual([0, 5]);
	});

	test("a mapped block answers from its runs", () => {
		const blk = new Block("  <p>ab cd</p>", "ab cd", "text");
		blk.offset = -1;
		blk.runs = [{ at: 0, src: 5, n: 5 }];
		expect(sourceSpan(blk, 0, 2)).toEqual([5, 7]);
		expect(sourceSpan(blk, 3, 3)).toEqual([8, 8]);
	});

	test("an unmapped block has nothing to say", () => {
		const blk = new Block("something else entirely", "ab cd", "text");
		blk.offset = -1;
		expect(sourceSpan(blk, 0, 2)).toBeNull();
	});

	test("a span that does not fit is refused", () => {
		const blk = new Block("", "hello", "raw");
		expect(sourceSpan(blk, -1, 2)).toBeNull();
		expect(sourceSpan(blk, 0, 99)).toBeNull();
		expect(sourceSpan(blk, 3, 1)).toBeNull();
	});
});

describe.skipIf(!tengoAvailable())("a script rule", () => {
	const source = `
text := import("text")

matches := []
idx := text.index(scope, "storage")
if idx >= 0 {
	matches = append(matches, {begin: idx, end: idx + 7})
}
`;

	test("returns the spans its program found", () => {
		const cfg = testConfig();
		const rule = new Script(
			cfg,
			{
				extends: "script",
				name: "Storage.Layer",
				level: "error",
				message: "'%s' here",
				script: source,
			},
			"Storage.yml",
		);

		const alerts = rule.run(
			new Block("", "the storage layer", "text"),
			testFile(),
			cfg,
		);
		expect(alerts.length).toBe(1);
		expect(alerts[0]!.match).toBe("storage");
		expect(alerts[0]!.span).toEqual([4, 11]);
	});

	test("a program that never returns is reported rather than left to run", () => {
		// Without the deadline this test does not fail, it hangs.
		const cfg = testConfig();
		const rule = new Script(
			cfg,
			{
				extends: "script",
				name: "Runaway.Loop",
				level: "error",
				message: "m",
				script: "matches := []\nfor { }",
			},
			"Runaway.yml",
		);

		let message = "";
		try {
			rule.run(new Block("", "some text", "text"), testFile(), cfg);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		// The report has to name the rule: a file may hold several checks.
		expect(message).toContain("Runaway.Loop");
		expect(message).toContain("did not finish within");
	});
});
