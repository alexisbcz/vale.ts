import { describe, expect, test } from "bun:test";
import { Repetition } from "../src/index.ts";
import { block, testConfig, testFile } from "./helpers.ts";

function makeRepetition(def: Record<string, unknown> = {}): Repetition {
	return new Repetition(
		testConfig(),
		{
			extends: "repetition",
			name: "Vale.Repetition",
			level: "error",
			message: "'%s' is repeated!",
			ignorecase: true,
			alpha: true,
			action: { name: "edit", params: ["truncate", " "] },
			tokens: [String.raw`[^\s.!?]+`],
			...def,
		},
		"internal",
	);
}

describe("a repeated word is reported", () => {
	const rule = makeRepetition();
	const cases: Array<[string, number]> = [
		["This is is a test.", 1],
		["This is a test.", 0],
		// A sentence boundary between the two is a false positive, so the span
		// has to be one sentence.
		["I almost forgot about that. That is important.", 0],
		// `alpha` means only letters count as a repetition.
		["Wait , , here.", 0],
	];

	for (const [text, want] of cases) {
		test(JSON.stringify(text), () => {
			expect(rule.run(block(text, "text"), testFile(), testConfig()).length).toBe(
				want,
			);
		});
	}
});

test("the alert names the repeated word and suggests the single one", () => {
	const rule = makeRepetition();
	const alerts = rule.run(block("This is is a test.", "text"), testFile(), testConfig());
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.message).toBe("'is' is repeated!");
	expect(alerts[0]!.suggestions).toEqual(["is"]);
	expect(alerts[0]!.hasByteOffsets).toBe(true);
});

test("an exception suppresses a repetition", () => {
	const rule = makeRepetition({ exceptions: ["that that"] });
	expect(
		rule.run(block("He said that that was fine.", "text"), testFile(), testConfig())
			.length,
	).toBe(0);
});

test("`max` allows that many repetitions", () => {
	const rule = makeRepetition({ max: 1 });
	expect(
		rule.run(block("ha ha ha here", "text"), testFile(), testConfig()).length,
	).toBe(1);
});
