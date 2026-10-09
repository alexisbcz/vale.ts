import { describe, expect, test } from "bun:test";
import { Capitalization, sentence, strcase, title } from "../src/index.ts";
import { block, testConfig, testFile } from "./helpers.ts";

/**
 * The score a heading gets against its sentence-cased form, at a threshold of
 * 1 -- every word has to agree.
 */
describe("sentence-case scoring", () => {
	const cases: Array<[string, boolean, string[]]> = [
		["Top-level entities", true, []],
		["Non-member Predicates", false, []],
		["Non-member predicates", true, []],
		["Client's key share and finish", true, []],
		["Client’s key share and finish", true, []],
		["Find the thief: Introduction", true, []],
		["Creating a connection to Event Store", true, ["Event Store"]],
		["Using errata-ai/vale", true, ["errata-ai/vale"]],
		["Use the Package Builder to install", false, []],
		["Use the Package Builder to install", true, ["Package Builder"]],
		["Use the High-Def Render Pipeline to install", false, []],
		["1. An important heading", true, []],
		["An important heading", true, []],
		["An important Heading", false, []],
		["this isn't in sentence case", false, []],
		["Community Leader responsibilities", false, []],
		["Community Leader responsibilities", true, ["Community Leader"]],
	];

	for (const [heading, want, exceptions] of cases) {
		test(`${JSON.stringify(heading)}${exceptions.length > 0 ? ` (${exceptions.join(", ")})` : ""}`, () => {
			const sc = new strcase.SentenceConverter({ vocab: exceptions });
			const [, matched] = sentence(heading, null, sc, 1);
			expect(matched).toBe(want);
		});
	}
});

describe("title-case scoring", () => {
	const tc = new strcase.TitleConverter(strcase.apStyle);
	const cases: Array<[string, boolean]> = [
		["A Title Here", true],
		["a title here", false],
		["The Quick Brown Fox", true],
	];

	for (const [heading, want] of cases) {
		test(JSON.stringify(heading), () => {
			const [, matched] = title(heading, null, tc, 1);
			expect(matched).toBe(want);
		});
	}
});

test("a $title rule carries its suggestion", () => {
	const cfg = testConfig();
	const rule = new Capitalization(
		cfg,
		{
			extends: "capitalization",
			message: "'%s' should be '%s'.",
			match: "$title",
			action: { name: "replace" },
		},
		"T/Title.yml",
	);

	const alerts = rule.run(block("a title here"), testFile(), cfg);
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.suggestions).toEqual(["A Title Here"]);
	expect(alerts[0]!.message).toBe("'a title here' should be 'A Title Here'.");
});

test("$lower and $upper compare against the whole block", () => {
	const cfg = testConfig();
	for (const [match, text, want] of [
		["$lower", "all lower", 0],
		["$lower", "Not All Lower", 1],
		["$upper", "ALL UPPER", 0],
		["$upper", "not upper", 1],
	] as Array<[string, string, number]>) {
		const rule = new Capitalization(
			cfg,
			{ extends: "capitalization", message: "'%s' -> '%s'", match },
			"T/Case.yml",
		);
		expect(rule.run(block(text), testFile(), cfg).length).toBe(want);
	}
});

test("a threshold lets one word disagree", () => {
	const cfg = testConfig();
	const rule = new Capitalization(
		cfg,
		{
			extends: "capitalization",
			message: "'%s' -> '%s'",
			match: "$sentence",
			threshold: 0.5,
		},
		"T/Sentence.yml",
	);
	// Four words, one of them wrongly capitalized: above the threshold.
	expect(rule.run(block("Mostly fine Heading here"), testFile(), cfg).length).toBe(
		0,
	);
});
