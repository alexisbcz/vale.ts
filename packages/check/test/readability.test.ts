import { expect, test } from "bun:test";
import { measuredScope, Readability } from "../src/index.ts";
import { block, testConfig, testFile } from "./helpers.ts";

function makeReadability(def: Record<string, unknown>): Readability {
	return new Readability(
		testConfig(),
		{
			extends: "readability",
			name: "Test.Readability",
			level: "warning",
			message: "Grade level: %s.",
			...def,
		},
		"Test.Readability",
	);
}

test("a known metric measures the summary", () => {
	const rule = makeReadability({ metrics: ["Flesch-Kincaid"], grade: 8 });
	expect(rule.fields().scope).toEqual(["summary"]);
});

test("a metric this check does not know runs on text", () => {
	const rule = makeReadability({ metrics: ["Nonsense"], grade: 8 });
	expect(rule.fields().scope).toEqual(["text"]);
});

test("a declared scope is kept", () => {
	const rule = makeReadability({
		metrics: ["Flesch-Kincaid"],
		grade: 8,
		scope: ["paragraph"],
	});
	expect(rule.fields().scope).toEqual(["paragraph"]);
});

test("`text` means the summary, as an unset scope used to compile to", () => {
	expect(measuredScope([])).toEqual(["summary"]);
	expect(measuredScope(["text"])).toEqual(["summary"]);
	expect(measuredScope(["paragraph"])).toEqual(["paragraph"]);
});

test("a grade over the threshold is reported", () => {
	const dense =
		"The aforementioned institutional methodologies necessitate " +
		"comprehensive reconsideration notwithstanding organizational " +
		"predispositions toward incrementalism.";

	const over = makeReadability({ metrics: ["Flesch-Kincaid"], grade: 2 });
	const alerts = over.run(block(dense, "summary"), testFile(), testConfig());
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.message).toMatch(/^Grade level: \d+\.\d\d\.$/);

	const under = makeReadability({ metrics: ["Flesch-Kincaid"], grade: 100 });
	expect(under.run(block(dense, "summary"), testFile(), testConfig()).length).toBe(
		0,
	);
});

test("several metrics are averaged", () => {
	const text = "The dog ran. The cat sat. The bird flew.";
	const rule = makeReadability({
		metrics: ["Flesch-Kincaid", "Gunning Fog", "SMOG"],
		grade: 0,
	});
	const alerts = rule.run(block(text, "summary"), testFile(), testConfig());
	expect(alerts.length).toBe(1);
});
