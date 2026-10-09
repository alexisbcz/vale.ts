import { expect, test } from "bun:test";
import { Consistency } from "../src/index.ts";
import { block, testConfig, testFile, wordTemplateConfig } from "./helpers.ts";

function makeConsistency(either: Record<string, string>): Consistency {
	return new Consistency(
		wordTemplateConfig(),
		{
			extends: "consistency",
			name: "Test.Spelling",
			level: "warning",
			message: "Inconsistent spelling of '%s'.",
			ignorecase: true,
			either,
		},
		"Test.Spelling",
	);
}

test("both spellings in one block are reported once", () => {
	const rule = makeConsistency({ center: "centre" });
	const f = testFile();

	const alerts = rule.run(
		block("The center and the centre.", "text"),
		f,
		wordTemplateConfig(),
	);
	expect(alerts.length).toBe(1);
	// Reported under the rule's own name rather than the per-term one.
	expect(alerts[0]!.check).toBe("Test.Spelling");
});

test("one spelling on its own is not reported", () => {
	const rule = makeConsistency({ center: "centre" });
	const f = testFile();
	expect(
		rule.run(block("The center only.", "text"), f, wordTemplateConfig()).length,
	).toBe(0);
});

test("the two spellings may be seen in different blocks", () => {
	// A `consistency` rule keeps its state on the file, so the pair need not
	// sit in one block.
	const rule = makeConsistency({ color: "colour" });
	const f = testFile();

	expect(rule.run(block("A color.", "text"), f, testConfig()).length).toBe(0);
	expect(rule.run(block("A colour.", "text"), f, testConfig()).length).toBe(1);
});

test("the rule's name records the extension point it came from", () => {
	const rule = makeConsistency({ center: "centre" });
	expect(rule.fields().extends).toBe("Test.Spelling");
});
