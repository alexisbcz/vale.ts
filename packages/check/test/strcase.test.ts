import { describe, expect, test } from "bun:test";
import { strcase } from "../src/index.ts";

describe("sentence case", () => {
	const cases: Array<[string, string]> = [
		["", ""],
		["1. An important heading", "1. An important heading"],
		["getting started with Vale server", "Getting started with vale server"],
		[
			"Lession 1: getting started with vale server",
			"Lession 1: Getting started with vale server",
		],
		["Top-Level ideas", "Top-level ideas"],
		["Intro to the top-level idEas", "Intro to the top-level ideas"],
		["build-backend tools", "Build-backend tools"],
		["README files", "Readme files"],
	];

	const sc = new strcase.SentenceConverter();
	for (const [input, want] of cases) {
		test(JSON.stringify(input), () => {
			expect(sc.convert(input)).toBe(want);
		});
	}
});

describe("sentence case with a vocabulary", () => {
	const cases: Array<[string, string]> = [
		["Getting started with vale server", "Getting started with Vale Server"],
		["Issue triage", "Issue triage"],
		["macOS 15: What's new", "macOS 15: What's new"],
		["Configuration", "Configuration"],
		[
			"Six NASA Instruments Will Fly to Moon on Intuitive Machines Lander",
			"Six NASA instruments will fly to Moon on intuitive machines lander",
		],
		["b. Next title text", "b. Next title text"],
		["Axon Server connection", "Axon Server connection"],
		["vale ale", "Vale ale"],
	];

	const sc = new strcase.SentenceConverter({
		vocab: [
			"Vale Server",
			String.raw`\bI\b`,
			"macOS",
			"[Cc]onfig",
			"NASA",
			"Moon",
			"Axon",
			"Axon Server",
			String.raw`\bale\b`,
		],
		prefix: String.raw`^[a-z]\.\s`,
	});
	for (const [input, want] of cases) {
		test(JSON.stringify(input), () => {
			expect(sc.convert(input)).toBe(want);
		});
	}
});

describe("title case with a vocabulary", () => {
	const cases: Array<[string, string]> = [
		["Getting started with iOS 15", "Getting Started With iOS 15"],
		["Understanding json and yaml", "Understanding JSON and YAML"],
		["Develop File-Proxy Plugin", "Develop File-Proxy Plugin"],
		["b. Next title text", "b. Next Title Text"],
		["vale ale", "Vale ale"],
		["New Repository and Project", "New Repository and Project"],
	];

	const tc = new strcase.TitleConverter(strcase.apStyle, {
		vocab: ["iOS", "JSON", "YAML", String.raw`\bale\b`, "[Rr]epo"],
		prefix: String.raw`^[a-z]\.\s`,
	});
	for (const [input, want] of cases) {
		test(JSON.stringify(input), () => {
			expect(tc.convert(input)).toBe(want);
		});
	}
});

describe("AP style leaves the short words alone", () => {
	const tc = new strcase.TitleConverter(strcase.apStyle);
	const cases: Array<[string, string]> = [
		["a title here", "A Title Here"],
		["the quick brown fox", "The Quick Brown Fox"],
		["war and peace", "War and Peace"],
	];
	for (const [input, want] of cases) {
		test(input, () => {
			expect(tc.convert(input)).toBe(want);
		});
	}
});

describe("Chicago style lowercases prepositions of any length", () => {
	const tc = new strcase.TitleConverter(strcase.chicagoStyle);
	test("a longer preposition", () => {
		expect(tc.convert("life throughout the ages")).toBe("Life throughout the Ages");
	});
});

describe("the word-level converters", () => {
	const cases: Array<[(s: string) => string, string, string]> = [
		[strcase.simple, "FooBar", "foo bar"],
		[strcase.dash, "FooBar", "foo-bar"],
		[strcase.snake, "FooBar", "foo_bar"],
		[strcase.camel, "foo bar", "fooBar"],
		[strcase.pascal, "foo bar", "FooBar"],
		[strcase.constant, "foo bar", "FOO_BAR"],
		[strcase.simple, "already simple", "already simple"],
		[strcase.dash, "snake_case_name", "snake-case-name"],
	];

	for (const [fn, input, want] of cases) {
		test(`${fn.name}(${input})`, () => {
			expect(fn(input)).toBe(want);
		});
	}
});

test("toTitle uppercases the first character", () => {
	expect(strcase.toTitle("élan", false)).toBe("Élan");
	expect(strcase.toTitle("ÉLAN", true)).toBe("Élan");
	expect(strcase.toTitle("", true)).toBe("");
});
