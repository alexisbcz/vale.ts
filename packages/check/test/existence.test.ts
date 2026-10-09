import { describe, expect, test } from "bun:test";
import { Block } from "@vale-ts/core";
import { Existence, groupSpans } from "../src/index.ts";
import { block, testConfig, testFile } from "./helpers.ts";

function makeExistence(tokens: string[]): Existence {
	return new Existence(testConfig(), { tokens }, "");
}

test("a token is reported where it occurs", () => {
	const rule = makeExistence(["test"]);
	const alerts = rule.run(block("This is a test."), testFile(), testConfig());
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.match).toBe("test");
});

describe("a `%` in a raw pattern survives the template", () => {
	// The raw pattern is joined into a format string, so its own `%` has to be
	// escaped and then unescaped.
	const cases: Array<[string, number]> = [
		["%", 2],
		["50%", 1],
		["%s", 1],
		["%[sd]", 1],
	];

	for (const [raw, want] of cases) {
		test(raw, () => {
			const cfg = testConfig();
			const rule = new Existence(cfg, { raw: [raw], nonword: true }, "");
			const alerts = rule.run(
				block("Save %s files. A 50% discount."),
				testFile(),
				cfg,
			);
			expect(alerts.length).toBe(want);
		});
	}
});

test("every match is anchored at its own offset", () => {
	const rule = makeExistence(["simply"]);

	for (const prefix of ["", "Ünd so: "]) {
		const unit = "This is simply a test. ";
		const text = prefix + unit.repeat(500);
		const blk = new Block("", text, "text");

		const alerts = rule.run(blk, testFile(), testConfig());
		expect(alerts.length).toBe(500);
		for (let i = 0; i < alerts.length; i++) {
			const a = alerts[i]!;
			const lo = prefix.length + i * unit.length + "This is ".length;
			expect(a.hasByteOffsets).toBe(true);
			expect(a.span).toEqual([lo, lo + "simply".length]);
			expect(blk.text.slice(a.span[0]!, a.span[1]!)).toBe("simply");
		}
	}
});

test("an exception suppresses a match", () => {
	const cfg = testConfig();
	const rule = new Existence(
		cfg,
		{ tokens: ["simple"], exceptions: ["simple"] },
		"",
	);
	expect(rule.run(block("This is simple."), testFile(), cfg).length).toBe(0);
});

test("an accepted phrase suppresses a match on one of its words", () => {
	const cfg = testConfig();
	cfg.acceptedTokens = ["mea culpa"];
	const rule = new Existence(cfg, { tokens: ["mea"] }, "");
	expect(rule.run(block("A mea culpa follows."), testFile(), cfg).length).toBe(
		0,
	);
	expect(rule.run(block("A mea of sorts."), testFile(), cfg).length).toBe(1);
});

test("a vocabulary word is not an exception for a nonword rule", () => {
	// A `nonword` token matches an arbitrary span, where a vocabulary word
	// would suppress any match that merely contains it.
	const cfg = testConfig();
	cfg.acceptedTokens = ["plugh"];
	const rule = new Existence(
		cfg,
		{ tokens: [String.raw`"[^"]+"[.,]`], nonword: true },
		"",
	);
	expect(rule.run(block('He said "plugh", loudly.'), testFile(), cfg).length).toBe(
		1,
	);
});

describe("groupSpans maps each token's groups into the joined pattern", () => {
	test("unnamed groups come before named ones", () => {
		const spans = groupSpans(
			[String.raw`(\w+) (?P<last>\w+)`, String.raw`(\w+)`],
			"",
			true,
		);
		expect(spans[0]).toEqual({
			unnamed: 0,
			unnamedCount: 1,
			named: 2,
			namedCount: 1,
		});
		expect(spans[1]).toEqual({
			unnamed: 1,
			unnamedCount: 1,
			named: 3,
			namedCount: 0,
		});
	});

	test("the raw pattern takes the first or the last slot", () => {
		expect(groupSpans(["(a)"], "(b)", false).length).toBe(1);
		expect(groupSpans(["(a)"], "(b)", true).length).toBe(1);
	});
});
