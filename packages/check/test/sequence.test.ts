import { describe, expect, test } from "bun:test";
import { Block, computeBlocks, newNLPInfo } from "@vale-ts/core";
import { segmentText } from "@vale-ts/nlp";
import { newScope, Sequence, sentenceScope, stepsToString } from "../src/index.ts";
import { testFile, wordTemplateConfig } from "./helpers.ts";

function makeSequence(def: Record<string, unknown>): Sequence {
	return new Sequence(wordTemplateConfig(), def, String(def.name ?? "T.S"));
}

/** A placed block, as the real linter hands one to a rule. */
function sentenceBlock(text: string): Block {
	return new Block(text, text, "text");
}

/**
 * A sequence position names the word it accepts, so it has to match the whole
 * token: reusing the unanchored candidate pattern made `pattern: self` accept
 * the single token `self-worth`.
 */
describe("a position matches a whole token", () => {
	const rule = makeSequence({
		extends: "sequence",
		name: "Test.Yourself",
		level: "error",
		message: "Did you mean 'yourself'?",
		tokens: [{ pattern: "your" }, { pattern: "self" }],
	});

	const cases: Array<[string, string, number]> = [
		["exact words", "Ask your self what matters.", 1],
		["hyphenated compound", "Question your self-worth sometimes.", 0],
		["longer word", "Consider your selfishness here.", 0],
	];

	for (const [name, text, want] of cases) {
		test(name, () => {
			const alerts = rule.run(
				sentenceBlock(text),
				testFile(),
				wordTemplateConfig(),
			);
			expect(alerts.length).toBe(want);
		});
	}
});

describe("sentenceScope narrows a declared scope to its sentences", () => {
	const cases: Array<[string, string[], string[]]> = [
		["unset means every sentence", [], ["sentence"]],
		["a block scope is narrowed", ["list"], ["sentence & list"]],
		["already a sentence scope", ["sentence"], ["sentence"]],
		["already narrowed", ["sentence.list"], ["sentence.list"]],
		// A bare negated term never mentions `sentence`, so the fragment
		// blocks were skipped for it and the rule matched the whole
		// unsegmented block instead.
		["negation is AND-ed with sentence", ["~list"], ["sentence&~list"]],
		[
			"a chained negation is AND-ed the same way",
			["~list&text"],
			["sentence&~list&text"],
		],
		[
			"a selector is a term, not a sub-scope",
			["doc(h2 + p)"],
			["sentence & doc(h2 + p)"],
		],
		[
			"several at once",
			["heading", "list"],
			["sentence & heading", "sentence & list"],
		],
		// `paragraph` names no block of its own: splitting wraps every block
		// as `paragraph.<scope>`, so `sentence.paragraph` is built for nothing.
		["paragraph is not narrowed further", ["paragraph"], ["sentence"]],
		["a qualified paragraph keeps its qualifier", ["paragraph.md"], ["sentence.md"]],
		[
			"a scope merely starting with the word is left alone",
			["paragraphs"],
			["sentence & paragraphs"],
		],
	];

	for (const [name, declared, want] of cases) {
		test(name, () => {
			expect(sentenceScope(declared)).toEqual(want);
		});
	}
});

/**
 * The dispatched consequence of the negation above: a rule with a bare negated
 * scope matched the same sentence through two different blocks at once, and
 * one real match produced two identical alerts.
 */
test("a negated scope does not double-report", () => {
	const cfg = wordTemplateConfig();
	const rule = makeSequence({
		extends: "sequence",
		name: "Test.WidgetArrivedNegatedScope",
		level: "error",
		ignorecase: true,
		message: "matched",
		scope: ["~list"],
		tokens: [{ pattern: "widget" }, { pattern: "arrived", skip: 1 }],
	});

	const text = "I bought a widget that arrived promptly, said the courier.";
	const info = newNLPInfo({ segmentation: true, splitting: true });
	const blocks = computeBlocks(
		info,
		new Block("", text, "text.md", 1),
		true,
		segmentText,
	);

	const scope = newScope(rule.fields().scope);
	const f = testFile();

	let total = 0;
	for (const blk of blocks) {
		if (!scope.matches(blk)) continue;
		total += rule.run(blk, f, cfg).length;
	}

	expect(total).toBe(1);
});

test("a `paragraph` scope reaches a paragraph's sentences", () => {
	const paragraphSentence = new Block(
		"",
		"A sentence in a paragraph.",
		"sentence.text.md",
		1,
	);

	for (const declared of ["paragraph", "sentence"]) {
		const rule = makeSequence({
			extends: "sequence",
			name: "Test.Sequence",
			level: "error",
			message: "Sequence matched '%s'.",
			scope: [declared],
			tokens: [{ pattern: "in" }, { pattern: "a" }],
		});
		expect(newScope(rule.fields().scope).matches(paragraphSentence)).toBe(true);
	}
});

/**
 * A token found inside its `skip` window satisfies that window alone: the
 * tokens after it still have to hold.
 */
describe("the tokens after a skip window are still verified", () => {
	const rule = makeSequence({
		extends: "sequence",
		name: "Test.AfterWindow",
		level: "error",
		message: "matched",
		tokens: [{ pattern: "the" }, { tag: "NN", skip: 3 }, { tag: "VBD" }],
	});

	const cases: Array<[string, string, number]> = [
		["verb follows the noun", "Then the big dog barked loudly today.", 1],
		["no verb follows", "Near the big dog yesterday morning.", 0],
	];

	for (const [name, text, want] of cases) {
		test(name, () => {
			expect(
				rule.run(sentenceBlock(text), testFile(), wordTemplateConfig()).length,
			).toBe(want);
		});
	}
});

describe("`min` asks for repeated occurrences", () => {
	const rule = makeSequence({
		extends: "sequence",
		name: "Test.Ambiguous",
		level: "warning",
		message: "Avoid ambiguous pronouns.",
		tokens: [
			{ tag: "NN|NNP|NNPS|NNS", skip: 4, min: 2 },
			{ pattern: String.raw`\w+`, tag: "PRP" },
		],
	});

	const cases: Array<[string, string, number]> = [
		["two nouns before it", "The dog chased the cat until it tired.", 1],
		["one noun before it", "The dog barked because it hungered.", 0],
		["no nouns before it", "Suddenly it stopped.", 0],
	];

	for (const [name, text, want] of cases) {
		test(name, () => {
			expect(
				rule.run(sentenceBlock(text), testFile(), wordTemplateConfig()).length,
			).toBe(want);
		});
	}
});

describe("a negated token is satisfied at a sentence boundary", () => {
	// "not preceded by X" holds when nothing precedes the match at all.
	const rule = makeSequence({
		extends: "sequence",
		name: "Test.NotAfterAnd",
		level: "warning",
		ignorecase: true,
		message: "matched",
		tokens: [
			{ tag: "CC", negate: true },
			{ pattern: "dogs" },
			{ pattern: "bark" },
		],
	});

	const cases: Array<[string, string, number]> = [
		["sentence-initial match", "Dogs bark at night.", 1],
		["preceded by an allowed word", "Some dogs bark at night.", 1],
		["preceded by a conjunction", "Cats meow and dogs bark.", 0],
	];

	for (const [name, text, want] of cases) {
		test(name, () => {
			expect(
				rule.run(sentenceBlock(text), testFile(), wordTemplateConfig()).length,
			).toBe(want);
		});
	}
});

describe("the same vacuous truth applies on the right", () => {
	const negated = makeSequence({
		extends: "sequence",
		name: "Test.NotBeforeNoun",
		level: "warning",
		ignorecase: true,
		message: "matched",
		tokens: [
			{ pattern: "dogs" },
			{ pattern: "bark" },
			{ tag: "IN", negate: true },
		],
	});
	const required = makeSequence({
		extends: "sequence",
		name: "Test.BeforePreposition",
		level: "warning",
		ignorecase: true,
		message: "matched",
		tokens: [{ pattern: "dogs" }, { pattern: "bark" }, { tag: "IN" }],
	});

	const cases: Array<[string, Sequence, string, number]> = [
		["negated, sentence ends", negated, "Dogs bark", 1],
		["negated, followed by a preposition", negated, "Dogs bark at night", 0],
		["required, sentence ends", required, "Dogs bark", 0],
		["required, followed by a preposition", required, "Dogs bark at night", 1],
	];

	for (const [name, rule, text, want] of cases) {
		test(name, () => {
			expect(
				rule.run(sentenceBlock(text), testFile(), wordTemplateConfig()).length,
			).toBe(want);
		});
	}
});

describe("an exception marks a region a match may not begin in", () => {
	const rule = makeSequence({
		extends: "sequence",
		name: "Test.Excepted",
		level: "warning",
		ignorecase: true,
		message: "matched",
		exceptions: ["^[^,]+,"],
		tokens: [{ pattern: "dogs" }, { pattern: "bark" }],
	});

	const cases: Array<[string, string, number]> = [
		["match begins inside the region", "Wild dogs bark, cats meow.", 0],
		["match begins after the region", "After dark, dogs bark.", 1],
		["no region in the sentence", "Wild dogs bark loudly.", 1],
	];

	for (const [name, text, want] of cases) {
		test(name, () => {
			expect(
				rule.run(sentenceBlock(text), testFile(), wordTemplateConfig()).length,
			).toBe(want);
		});
	}
});

describe("without `skip`, `min` means consecutive occurrences", () => {
	const rule = makeSequence({
		extends: "sequence",
		name: "Test.Stacked",
		level: "warning",
		message: "Stacked modifiers.",
		tokens: [
			{ tag: "JJ", min: 2 },
			{ pattern: String.raw`\w+`, tag: "NN" },
		],
	});

	const cases: Array<[string, string, number]> = [
		["two adjectives", "It was a big red dog.", 1],
		["one adjective", "It was a big dog.", 0],
	];

	for (const [name, text, want] of cases) {
		test(name, () => {
			expect(
				rule.run(sentenceBlock(text), testFile(), wordTemplateConfig()).length,
			).toBe(want);
		});
	}
});

test("a token cannot set both `tag` and `upos`", () => {
	expect(() =>
		makeSequence({
			extends: "sequence",
			name: "Test.Both",
			message: "m",
			tokens: [{ tag: "NN", upos: "NOUN" }],
		}),
	).toThrow();
});

test("an unknown universal tag is refused", () => {
	expect(() =>
		makeSequence({
			extends: "sequence",
			name: "Test.Upos",
			message: "m",
			tokens: [{ upos: "WIDGET" }],
		}),
	).toThrow();
});

test("`upos` reads the equivalent Penn tags", () => {
	const rule = makeSequence({
		extends: "sequence",
		name: "Test.Upos",
		level: "warning",
		message: "matched",
		tokens: [{ pattern: "the" }, { upos: "NOUN" }],
	});
	expect(
		rule.run(sentenceBlock("Open the door."), testFile(), wordTemplateConfig())
			.length,
	).toBe(1);
	expect(
		rule.run(sentenceBlock("Open the quickly."), testFile(), wordTemplateConfig())
			.length,
	).toBe(0);
});

test("`target` narrows the alert to the marked token", () => {
	const rule = makeSequence({
		extends: "sequence",
		name: "Test.Target",
		level: "warning",
		message: "matched",
		tokens: [{ pattern: "very" }, { pattern: "good", target: true }],
	});
	const alerts = rule.run(
		sentenceBlock("That is very good."),
		testFile(),
		wordTemplateConfig(),
	);
	expect(alerts.length).toBe(1);
	expect(alerts[0]!.match).toBe("good");
});

describe("stepsToString re-joins a match the way English is written", () => {
	const cases: Array<[string[], string]> = [
		[["Dogs", "bark"], "Dogs bark"],
		[["Dogs", "bark", "."], "Dogs bark."],
		[["she", "'s", "here"], "she's here"],
		// The opening parenthesis gets a space before it and, despite what the
		// comment in the Go original says, the word after it does too.
		[["see", "(", "below", ")"], "see ( below)"],
		[["a", ",", "b"], "a, b"],
	];

	for (const [steps, want] of cases) {
		test(want, () => {
			expect(stepsToString(steps)).toBe(want);
		});
	}
});
