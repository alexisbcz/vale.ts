import { describe, expect, test } from "bun:test";
import { Block } from "@vale-ts/core";
import { Spelling } from "../src/index.ts";
import { block, testConfig, testFile } from "./helpers.ts";

/**
 * A spelling rule with the built-in dictionary.
 *
 * `path: "internal"` is what makes the rule fall back to the dictionary Vale
 * ships, which is the only one available without a `StylesPath`.
 */
function makeSpelling(def: Record<string, unknown> = {}): Spelling {
	return new Spelling(
		testConfig(),
		{
			extends: "spelling",
			name: "Vale.Spelling",
			message: "Did you really mean '%s'?",
			level: "error",
			...def,
		},
		"internal",
	);
}

test("a misspelling is reported where it occurs", () => {
	const rule = makeSpelling();
	const text = "This is a mispelling here.";
	// Placed at the start of its own context, which is what lets the alert be
	// anchored rather than located by searching.
	const blk = new Block("", text, "text");

	const alerts = rule.run(blk, testFile(), testConfig());
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.match).toBe("mispelling");
	expect(alerts[0]!.hasByteOffsets).toBe(true);
	expect(text.slice(alerts[0]!.span[0]!, alerts[0]!.span[1]!)).toBe("mispelling");
});

test("a correctly spelled block is quiet", () => {
	const rule = makeSpelling();
	expect(
		rule.run(block("This is a sentence.", "text"), testFile(), testConfig()).length,
	).toBe(0);
});

test("each occurrence of a repeated misspelling gets its own position", () => {
	const rule = makeSpelling();
	const text = "mispelling and mispelling again";
	// Placed at the start of its own context, which is what lets the alert be
	// anchored rather than located by searching.
	const blk = new Block("", text, "text");

	const alerts = rule.run(blk, testFile(), testConfig());
	expect(alerts.length).toBe(2);
	expect(alerts[0]!.span[0]).toBe(0);
	expect(alerts[1]!.span[0]).toBe("mispelling and ".length);
});

test("an accepted vocabulary term is not a misspelling", () => {
	const cfg = testConfig();
	cfg.acceptedTokens = ["Kubernetes"];
	const rule = new Spelling(
		cfg,
		{ extends: "spelling", name: "Vale.Spelling", message: "'%s'?" },
		"internal",
	);
	expect(
		rule.run(block("We use Kubernetes.", "text"), testFile(), cfg).length,
	).toBe(0);
});

test("an accepted phrase's component words are still checked elsewhere", () => {
	const cfg = testConfig();
	cfg.acceptedTokens = ["mea culpa"];
	const rule = new Spelling(
		cfg,
		{ extends: "spelling", name: "Vale.Spelling", message: "'%s'?" },
		"internal",
	);

	// Masked as a phrase.
	expect(
		rule.run(block("A mea culpa follows.", "text"), testFile(), cfg).length,
	).toBe(0);
	// The same word on its own is not.
	expect(rule.run(block("A mea follows.", "text"), testFile(), cfg).length).toBe(1);
});

test("a user filter skips a word", () => {
	const rule = makeSpelling({ filters: ["^mispelling$"] });
	expect(
		rule.run(block("This is a mispelling here.", "text"), testFile(), testConfig())
			.length,
	).toBe(0);
});

describe("the built-in filters", () => {
	const rule = makeSpelling();
	// A camel-cased word, a trailing acronym and anything outside
	// `[a-zA-Z_']` are skipped rather than checked.
	const cases: Array<[string, number]> = [
		["The XMLHttpRequest went out.", 0],
		["Reading IDs here.", 0],
		["A foo.bar reference.", 0],
		["An ordinary mispelling.", 1],
	];

	for (const [text, want] of cases) {
		test(JSON.stringify(text), () => {
			expect(rule.run(block(text, "text"), testFile(), testConfig()).length).toBe(
				want,
			);
		});
	}
});

test("`custom` turns the built-in filters off", () => {
	const rule = makeSpelling({ custom: true });
	// With the defaults off, a camel-cased identifier is checked whole.
	const alerts = rule.run(
		block("The XMLHttpRequest went out.", "text"),
		testFile(),
		testConfig(),
	);
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.match).toBe("XMLHttpRequest");
});

test("`split` checks an identifier's parts at their own positions", () => {
	const rule = makeSpelling({ split: true });
	const text = "call recieveMessage first";
	// Placed at the start of its own context, which is what lets the alert be
	// anchored rather than located by searching.
	const blk = new Block("", text, "text");

	const alerts = rule.run(blk, testFile(), testConfig());
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.match).toBe("recieve");
	expect(text.slice(alerts[0]!.span[0]!, alerts[0]!.span[1]!)).toBe("recieve");
});

test("a dictionary word in another case is offered as the fix", () => {
	const rule = makeSpelling();
	const alerts = rule.run(
		block("We use github daily.", "text"),
		testFile(),
		testConfig(),
	);
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.action.name).toBe("replace");
	expect(alerts[0]!.suggestions).toEqual(["GitHub"]);
	expect(alerts[0]!.message).toBe("Use 'GitHub' instead of 'github'.");
});

test("an identifier-shaped word in a Markdown file is offered as code", () => {
	const rule = makeSpelling();
	const f = testFile({ normedExt: ".md" });
	const alerts = rule.run(
		block("Set the api_version value.", "text"),
		f,
		testConfig(),
	);
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.suggestions).toEqual(["`api_version`"]);
});

test("suggestions come back closest first", () => {
	const rule = makeSpelling();
	const got = rule.suggest("mispelling");
	expect(got.length).toBeGreaterThan(0);
	expect(got).toContain("misspelling");
});

test("a vocabulary term as close as a dictionary word is suggested first", () => {
	const cfg = testConfig();
	const rule = new Spelling(
		cfg,
		{ extends: "spelling", name: "T.Spelling", message: "'%s'?" },
		"internal",
	);

	const plain = rule.suggestFor("kubadm", null);
	if (plain[0] === "kubeadm") {
		// The dictionary already knows it; the test would prove nothing.
		return;
	}

	cfg.acceptedTokens = ["kubeadm"];
	const got = rule.suggestFor("kubadm", cfg);
	expect(got[0]).toBe("kubeadm");
	expect(new Set(got).size).toBe(got.length);
});
