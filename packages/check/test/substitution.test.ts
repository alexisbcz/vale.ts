import { describe, expect, test } from "bun:test";
import { Block } from "@vale-ts/core";
import {
	convertCaptureGroups,
	expandPattern,
	getOptions,
	keepWrap,
	recaseToTerm,
	sharedLookaround,
	Substitution,
} from "../src/index.ts";
import { testConfig, testFile } from "./helpers.ts";

function makeSubstitution(def: Record<string, unknown>): Substitution {
	return new Substitution(testConfig(), def, "");
}

/** A block whose context is its own text, as the real linter builds one. */
function placed(text: string): Block {
	return new Block(text, text, "text");
}

test("a capture group in a swap key is made non-capturing", () => {
	expect(convertCaptureGroups("change in(?: )?to the (.*) directory")).toBe(
		"change in(?: )?to the (?:.*) directory",
	);
});

test("the alternation order does not drift between runs", () => {
	const swap = {
		extends: "substitution",
		name: "Vale.Terms",
		level: "error",
		message: "Use '%s' instead of '%s'.",
		scope: "text",
		ignorecase: true,
		swap: {
			"emnify iot supernetwork": "emnify IoT SuperNetwork",
			emnify: "emnify",
		},
	};

	const text = "EMnify IoT SuperNetwork";
	for (let i = 0; i < 20; i++) {
		const rule = makeSubstitution(swap);
		const actual = rule.run(placed(text), testFile(), testConfig());
		expect(actual.length).toBe(1);
		expect(actual[0]!.match).toBe("EMnify IoT SuperNetwork");
	}
});

test("a swap key may be a pattern", () => {
	const rule = makeSubstitution({
		extends: "substitution",
		name: "Vale.Terms",
		level: "error",
		message: "Use '%s' instead of '%s'.",
		scope: "text",
		ignorecase: true,
		swap: { "(?:foo|bar)": "sub" },
	});

	const actual = rule.run(placed("foo"), testFile(), testConfig());
	expect(actual[0]!.message).toBe("Use 'sub' instead of 'foo'.");
});

describe("sharedLookaround", () => {
	const cases: Array<[string, string[], string]> = [
		[
			"hoisted",
			[
				String.raw`(?<=\b(?:have|has)\s)went\b`,
				String.raw`(?<=\b(?:have|has)\s)ate\b`,
			],
			String.raw`(?<=\b(?:have|has)\s)`,
		],
		[
			"differing assertions",
			[String.raw`(?<=have\s)went\b`, String.raw`(?<=has\s)ate\b`],
			"",
		],
		["one term", [String.raw`(?<=have\s)went\b`], ""],
		["no assertion", [String.raw`went\b`, String.raw`ate\b`], ""],
		["not leading", ["a(?=b)", "a(?=c)"], ""],
		["capturing", [String.raw`(?<=(have)\s)went`, String.raw`(?<=(have)\s)ate`], ""],
		[
			"escaped paren inside",
			[String.raw`(?<=\)\s)went`, String.raw`(?<=\)\s)ate`],
			String.raw`(?<=\)\s)`,
		],
	];

	for (const [name, terms, want] of cases) {
		test(name, () => {
			expect(sharedLookaround(terms)).toBe(want);
		});
	}
});

test("hoisting a lookaround keeps each term's replacement", () => {
	const rule = makeSubstitution({
		extends: "substitution",
		name: "Vale.Tense",
		level: "error",
		message: "Use '%s' instead of '%s'.",
		scope: "text",
		ignorecase: true,
		nonword: true,
		swap: {
			[String.raw`(?<=\b(?:have|has)\s)went\b`]: "gone",
			[String.raw`(?<=\b(?:have|has)\s)ate\b`]: "eaten",
		},
	});

	const cases: Record<string, string> = {
		"they have went home": "Use 'gone' instead of 'went'.",
		"they have ate lunch": "Use 'eaten' instead of 'ate'.",
	};
	for (const [text, want] of Object.entries(cases)) {
		const alerts = rule.run(placed(text), testFile(), testConfig());
		expect(alerts.length).toBe(1);
		expect(alerts[0]!.message).toBe(want);
	}

	// The assertion still has to hold once hoisted.
	expect(
		rule.run(placed("they went home"), testFile(), testConfig()).length,
	).toBe(0);
});

// TODO: `@vale-ts/regex` cannot compile a quantified lookaround -- `(?!\))?`
// -- which `regexp2` accepts and this rule's term uses. Re-enable once the
// regex package translates it; nothing in this package can.
test.todo("escaped parentheses in a swap key are literal", () => {
	const rule = makeSubstitution({
		extends: "substitution",
		name: "Vale.Terms",
		level: "error",
		message: "Use '%s' instead of '%s'.",
		scope: "text",
		ignorecase: true,
		swap: { [String.raw`(?!\()(?:foo|bar)(?!\))?`]: "sub" },
	});

	const actual = rule.run(placed("(foo)"), testFile(), testConfig());
	expect(actual[0]!.message).toBe("Use 'sub' instead of 'foo'.");
});

test("a vocabulary term that is a pattern is shown re-cased", () => {
	// Mirrors how the manager builds `Vale.Terms`: lower(term) -> term.
	const rule = makeSubstitution({
		extends: "substitution",
		name: "Vale.Terms",
		level: "error",
		message: "Use '%s' instead of '%s'.",
		scope: "text",
		ignorecase: true,
		swap: { "oauth2?": "OAuth2?" },
	});

	const cases: Array<[string, string]> = [
		["oauth2", "Use 'OAuth2' instead of 'oauth2'."],
		["OAUTH2", "Use 'OAuth2' instead of 'OAUTH2'."],
	];
	for (const [text, want] of cases) {
		const actual = rule.run(placed(text), testFile(), testConfig());
		expect(actual.length).toBe(1);
		expect(actual[0]!.message).toBe(want);
	}
});

describe("recaseToTerm", () => {
	const cases: Array<[string, string, string]> = [
		["OAuth2?", "oauth2", "OAuth2"], // optional character present
		["OAuth2?", "Oauth", "OAuth"], // optional character absent
		["OpenAPI", "openapi", "OpenAPI"], // plain literal
		[String.raw`Wi\-?Fi`, "wi-fi", "Wi-Fi"], // escaped literal hyphen
		["Wi-?Fi", "wifi", "WiFi"], // optional character absent
		["Docker(file|ize)", "dockerfile", "Dockerfile"], // alternation
		["Docker(file|ize)", "DOCKERIZE", "Dockerize"],
		["(?:foo|bar)", "foo", "foo"], // non-capturing group

		// No spelling in the set matches, so the term stands.
		["Docker(file|ize)", "docker", "Docker(file|ize)"],

		// Not a finite set of spellings: nothing to name.
		["[Pp]ython", "python", "[Pp]ython"],
		[String.raw`Py.*\b`, "pythonic", String.raw`Py.*\b`],
		["Go+gle", "google", "Go+gle"],
	];

	for (const [term, observed, want] of cases) {
		test(`${term} vs ${observed}`, () => {
			expect(recaseToTerm(term, observed)).toBe(want);
		});
	}
});

describe("expandPattern", () => {
	const cases: Array<[string, string[] | null]> = [
		["OAuth", ["OAuth"]],
		["OAuth2?", ["OAuth2", "OAuth"]],
		["Docker(file|ize)", ["Dockerfile", "Dockerize"]],
		["Docker(?:file|ize)", ["Dockerfile", "Dockerize"]],
		["foo|bar", ["foo", "bar"]],
		[String.raw`Wi\-Fi`, ["Wi-Fi"]],
		["a(b|c)d?", ["abd", "ab", "acd", "ac"]],

		// An optional group: the whole group drops out.
		["Java(Script)?", ["JavaScript", "Java"]],

		// Unbounded or class-based: no finite set of spellings.
		["[Pp]ython", null],
		["Go+gle", null],
		["Py.*", null],
		[String.raw`\d+`, null],
		["a{2,3}", null],
		["(unclosed", null],
		["unopened)", null],
		["(?=lookahead)", null],
	];

	for (const [pattern, want] of cases) {
		test(pattern, () => {
			const got = expandPattern(pattern);
			if (want === null) expect(got).toBeNull();
			else expect(got?.slice().sort()).toEqual(want.slice().sort());
		});
	}
});

test("a blown expansion budget gives nothing rather than a partial set", () => {
	// A partial list would let `recaseToTerm` miss the spelling the writer
	// actually used and report the raw pattern, which is the bug it avoids.
	expect(expandPattern("(a|b)".repeat(7))).toBeNull();
	expect(expandPattern("(a|b)".repeat(5))?.length).toBe(32);
});

describe("getOptions", () => {
	const cases: Record<string, string[]> = {
		"foo|bar": ["foo", "bar"],
		"foo|bar|baz": ["foo", "bar", "baz"],
		"|foo|": ["foo"],
		[String.raw`\|foo\|`]: ["|foo|"],
		[String.raw`\|foo\||bar`]: ["|foo|", "bar"],
		"foo|bar|": ["foo", "bar"],
		"foo|": ["foo"],
		"|": [],
		[String.raw`\|`]: ["|"],

		// A suggestion is literal replacement text, so an option containing
		// the letters `PIPE` has to survive the split intact.
		PIPELINE: ["PIPELINE"],
		"PIPELINE|conduit": ["PIPELINE", "conduit"],
		[String.raw`PIPE\|LINE`]: ["PIPE|LINE"],
	};

	for (const [pattern, want] of Object.entries(cases)) {
		test(pattern, () => {
			expect(getOptions(pattern)).toEqual(want);
		});
	}
});

test("a fix to a wrapped phrase keeps the wrap", () => {
	expect(keepWrap("mea culpa", "Mea\nCulpa")).toBe("mea\nculpa");
	expect(keepWrap("mea culpa", "Mea Culpa")).toBe("mea culpa");
	expect(keepWrap("OAuth2", "oauth 2")).toBe("OAuth2");
});
