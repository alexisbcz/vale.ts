import { expect, test } from "bun:test";
import { Block } from "@vale-ts/core";
import { Occurrence } from "../src/index.ts";
import { block, testConfig, testFile, wordTemplateConfig } from "./helpers.ts";

/**
 * A zero-occurrence shortfall has no match to point at, but the scope that
 * fell short has a position of its own: its first word. Unanchored, the alert
 * collapsed onto line one, where one report also hid every other deficient
 * scope in the file.
 */
test("a shortfall is anchored to the scope's first word", () => {
	const cfg = wordTemplateConfig();
	const rule = new Occurrence(
		cfg,
		{
			extends: "occurrence",
			name: "Test.Presence",
			level: "warning",
			message: "No slang here (found %d).",
			scope: "paragraph",
			min: 1,
			token: String.raw`\b(?:no cap|cooked)\b`,
		},
		"Test.Presence",
	);

	const ctx = "This rollout is cooked.\n\nPlain corporate prose here.\n";
	const blk = new Block(ctx, "Plain corporate prose here.", "paragraph");
	blk.offset = "This rollout is cooked.\n\n".length;

	const alerts = rule.run(blk, testFile(), cfg);
	expect(alerts.length).toBe(1);

	const a = alerts[0]!;
	expect(a.hasByteOffsets).toBe(true);
	expect(a.span[0]).toBe(blk.offset);
	expect(a.match).toBe("Plain");
	expect(a.message).toBe("No slang here (found 0).");

	// A satisfied scope stays quiet.
	const ok = new Block(ctx, "This rollout is cooked.", "paragraph");
	expect(rule.run(ok, testFile(), cfg).length).toBe(0);
});

test("a count over `max` is reported at the first non-code match", () => {
	const cfg = testConfig();
	const rule = new Occurrence(
		cfg,
		{
			extends: "occurrence",
			name: "Test.Commas",
			level: "warning",
			message: "Too many commas (%d).",
			max: 2,
			token: ",",
		},
		"Test.Commas",
	);

	const alerts = rule.run(block("a, b, c, d"), testFile(), cfg);
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.message).toBe("Too many commas (3).");
	expect(alerts[0]!.match).toBe(",");
});
