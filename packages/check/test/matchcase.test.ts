import { describe, expect, test } from "bun:test";
import { matchCase, recase, words } from "../src/index.ts";

describe("matchCase", () => {
	const cases: Array<[string, string, string, string]> = [
		["lower stays lower", "A-OK", "a ok", "a-ok"],
		["shouted stays shouted", "A-OK", "A OK", "A-OK"],
		["capitalized keeps one capital", "A-OK", "A ok", "A-ok"],
		["already correct", "there", "their", "there"],
		["sentence start", "there", "Their", "There"],
		["shouted word", "there", "THEIR", "THERE"],
		["phrase capitalized", "aware of", "Aware about", "Aware of"],

		// A lone capital is a capitalized word, not a shouted one: "A" must
		// not turn every replacement it stands in for into upper case.
		["single letter", "and", "A", "And"],

		// Irregular casing carries no rule that can be copied onto another
		// string, so the replacement is left as the rule wrote it.
		["internal capitals", "iPhone", "IPhone", "iPhone"],
		["mixed case", "macOS", "MaC oS", "macOS"],
		["no letters", "replacement", "123", "replacement"],
		["empty", "replacement", "", "replacement"],
	];

	for (const [name, repl, observed, want] of cases) {
		test(name, () => {
			expect(matchCase(repl, observed)).toBe(want);
		});
	}
});

describe("matchCase reads a phrase word by word", () => {
	const cases: Array<[string, string, string, string]> = [
		["shouted then not", "blu-ray", "BLU ray", "BLU-ray"],
		["both capitalized", "cross-platform", "Cross Platform", "Cross-Platform"],
		[
			"uniform lower unchanged",
			"cross-platform",
			"cross platform",
			"cross-platform",
		],
		["uniform shouted", "cross-platform", "CROSS PLATFORM", "CROSS-PLATFORM"],

		// Differing word counts give nothing to line up, so the phrase is
		// judged as a whole.
		["count mismatch", "a lot", "Alot", "A lot"],
	];

	for (const [name, repl, observed, want] of cases) {
		test(name, () => {
			expect(matchCase(repl, observed)).toBe(want);
		});
	}
});

test("every suggestion a rule offers is re-cased", () => {
	expect(recase(["bad rap", "poor showing"], "Bad rep")).toEqual([
		"Bad rap",
		"Poor showing",
	]);
});

test("case comes from the text that was found", () => {
	// A lower-case match lower-cases the suggestion, which is why `matchcase`
	// is opt-in rather than always on.
	expect(matchCase("JavaScript", "javascript")).toBe("javascript");
});

test("rebuilding a phrase keeps its punctuation", () => {
	for (const s of [
		"",
		"hello",
		"blu-ray",
		"  spaced  out  ",
		"a's and b's",
		"...",
		"Cross-Platform!",
		"héllo wörld",
	]) {
		const [w, seps] = words(s);
		let out = "";
		for (let i = 0; i < w.length; i++) out += (seps[i] ?? "") + w[i]!;
		out += seps[w.length] ?? "";
		expect(out).toBe(s);
	}
});
