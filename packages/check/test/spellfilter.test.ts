import { describe, expect, test } from "bun:test";
import {
	certainRecase,
	DEFAULT_FILTERS,
	skipsCamel,
	skipsNonWord,
	skipsTrailingCaps,
	splitIdentifier,
} from "../src/index.ts";

/**
 * A deterministic generator, because these strings are fed to two
 * implementations of the same filter to check that they agree; a fixed seed
 * makes a failure reproducible.
 */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return state / 0x1_0000_0000;
	};
}

test("the hand-written filters agree with the patterns they replace", () => {
	const cases = [
		"", "a", "A", "hello", "Hello", "HELLO", "helloW", "CamelCase",
		"camelCase", "XMLHttpRequest", "iOS", "IDs", "don't", "it's", "_foo",
		"foo_bar", "foo-bar", "foo.bar", "café", "naïve", "Straße", "42",
		"a1b2", "ABCd", "aBC", "aBCd", "HTTPServer", "getHTTPResponse",
		"McDonald", "O'Brien", "e.g", "U.S.A", "ZZ", "aZ", "AaB", "AaBc",
		// The case a greedy scan got wrong: `[A-Z]+` can hand a capital back
		// to `\w+`.
		"'_0ZaAZ _",
	];

	const next = rng(1);
	const alphabet = " aAzZ_'0-.é";
	for (let i = 0; i < 4000; i++) {
		const n = 1 + Math.floor(next() * 12);
		let b = "";
		for (let j = 0; j < n; j++) {
			b += alphabet[Math.floor(next() * alphabet.length)]!;
		}
		cases.push(b);
	}

	const scans = [skipsCamel, skipsTrailingCaps, skipsNonWord];
	for (const w of cases) {
		for (let i = 0; i < DEFAULT_FILTERS.length; i++) {
			const re = DEFAULT_FILTERS[i]!;
			expect(scans[i]!(w)).toBe(re.test(w));
		}
	}
});

describe("splitIdentifier", () => {
	// Offsets are string indices, so `ÜberGröße` splits at 4 rather than at
	// Go's byte offset of 5.
	const cases: Record<string, Array<[string, number]>> = {
		getHTTPResponse_v2: [
			["get", 0],
			["HTTP", 3],
			["Response", 7],
			["v", 16],
		],
		recieveMessage: [
			["recieve", 0],
			["Message", 7],
		],
		RecieveMessage: [
			["Recieve", 0],
			["Message", 7],
		],
		recieve_message: [
			["recieve", 0],
			["message", 8],
		],
		"teh-thing": [
			["teh", 0],
			["thing", 4],
		],
		foo2bar: [
			["foo", 0],
			["bar", 4],
		],
		HTML: [["HTML", 0]],
		iPhone: [
			["i", 0],
			["Phone", 1],
		],
		plain: [["plain", 0]],
		"ÜberGröße": [
			["Über", 0],
			["Größe", 4],
		],
	};

	for (const [word, want] of Object.entries(cases)) {
		test(word, () => {
			expect(splitIdentifier(word)).toEqual(
				want.map(([text, at]) => ({ text, at })),
			);
		});
	}
});

describe("certainRecase", () => {
	const cases: Array<[string, string, boolean]> = [
		["github", "GitHub", true],
		["Github", "GitHub", true],
		["json", "JSON", true],
		["cpus", "CPUs", true],
		["Javascript", "JavaScript", true],
		["kubernetes", "Kubernetes", false], // capitalized only
		["los", "Los", false],
		["ui", "UI", false], // too short to be sure
		["CNs", "CNS", false], // already chose its capitals
		["PAM's", "Pam's", false],
	];

	for (const [word, cased, want] of cases) {
		test(`${word} -> ${cased}`, () => {
			expect(certainRecase(word, cased)).toBe(want);
		});
	}
});
