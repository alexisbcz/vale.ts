import { describe, expect, test } from "bun:test";
import { newAlert } from "@vale-ts/core";
import {
	cardinalWords,
	Existence,
	expandGroups,
	fixAlert,
	numberToWords,
	parseAlert,
	wordsToNumber,
} from "../src/index.ts";
import { block, testConfig, testFile } from "./helpers.ts";

describe("expandGroups", () => {
	const groups = ["alpha", "beta"];
	const cases: Array<[string, string]> = [
		["plain", "plain"],
		["$0", "whole"],
		["$1-$2", "alpha-beta"],
		["${2} then ${1}", "beta then alpha"],
		["$3", ""],
		["cost: $$5", "cost: $5"],
	];

	for (const [arg, want] of cases) {
		test(arg, () => {
			expect(expandGroups(arg, "whole", groups)).toBe(want);
		});
	}
});

describe("edit operations", () => {
	const cases: Array<[string, string[], string]> = [
		["too   many  spaces", ["squeeze"], "too many spaces"],
		["élan vital", ["capitalize"], "Élan vital"],
		["Élan Vital", ["uncapitalize"], "élan Vital"],
		[
			`He said "it's fine" -- really...`,
			["smart"],
			"He said “it’s fine” – really…",
		],
		["'quoted' --- yes", ["smart"], "‘quoted’ — yes"],
		["He said “it’s fine” – really…", ["dumb"], `He said "it's fine" -- really...`],
		["“Crème brûlée” — naïve", ["ascii"], `"Creme brulee" --- naive`],
		["Æsop, Straße, Øresund", ["ascii"], "AEsop, Strasse, Oresund"],
		["21", ["words"], "twenty-one"],
		["1,205", ["words"], "one thousand two hundred five"],
		["100", ["words"], "one hundred"],
		["3rd", ["words"], "third"],
		["22nd", ["words"], "twenty-second"],
		["40th", ["words"], "fortieth"],
		["112th", ["words"], "one hundred twelfth"],
		["-7", ["words"], "minus seven"],
		["lots", ["words"], "lots"],
		["twenty-one", ["digits"], "21"],
		["One Hundred and Five", ["digits"], "105"],
		["two thousand", ["digits"], "2000"],
		["one million two hundred thousand", ["digits"], "1200000"],
		["third", ["digits"], "3rd"],
		["twenty-second", ["digits"], "22nd"],
		["one hundred eleventh", ["digits"], "111th"],
		["minus seven", ["digits"], "-7"],
		["first light", ["digits"], "first light"],
		["several", ["digits"], "several"],
	];

	for (const [match, params, want] of cases) {
		test(`${params.join(" ")} on ${JSON.stringify(match)}`, () => {
			const got = fixAlert(
				newAlert({ match, action: { name: "edit", params } }),
				null,
			);
			expect(got).toEqual([want]);
		});
	}
});

test("numbers round-trip through words", () => {
	const values = [
		0n,
		5n,
		13n,
		20n,
		47n,
		99n,
		100n,
		101n,
		999n,
		1000n,
		1001n,
		12345n,
		1_000_000n,
		2_000_001n,
		1_000_000_000_000n,
	];
	for (const n of values) {
		const digits = wordsToNumber(cardinalWords(n));
		const words = numberToWords(digits);
		expect(wordsToNumber(words)).toBe(digits);
	}
});

describe("an edit step reads the token's groups", () => {
	const cases: Array<[{ name: string; params: string[] }, string]> = [
		[{ name: "edit", params: ["prefix", "$2 "] }, "bar foo_bar"],
		[{ name: "edit", params: ["replace", "$1", "$2"] }, "bar_bar"],
		[{ name: "replace", params: ["$2-$1"] }, "bar-foo"],
		// A regex step keeps `$1` for its own pattern.
		[
			{ name: "edit", params: ["regex", String.raw`(\w+)_(\w+)`, "$2 $1"] },
			"bar foo",
		],
	];

	for (const [action, want] of cases) {
		test(action.params.join(" "), () => {
			const got = fixAlert(
				newAlert({ match: "foo_bar", groups: ["foo", "bar"], action }),
				null,
			);
			expect(got).toEqual([want]);
		});
	}
});

test("a token's capture groups reach its own action", () => {
	const cfg = testConfig();

	const rule = new Existence(
		cfg,
		{
			extends: "existence",
			message: "'%s' -> '%s'",
			nonword: true,
			action: { name: "replace", params: ["$2, $1"] },
			tokens: [
				String.raw`(\w+) (?P<last>\w+) Jr\.`, // unnamed then named
				String.raw`Dr\. (\w+)`, // a second token with its own $1
				String.raw`Mx\. \w+`, // no groups at all
			],
		},
		"T/Names.yml",
	);

	const alerts = rule.run(
		block("Sammy Davis Jr., Dr. Who, Mx. Anyone"),
		testFile(),
		cfg,
	);
	expect(alerts.length).toBe(3);

	const want = [["Sammy", "Davis"], ["Who"], null];
	const wantFix = ["Davis, Sammy", ", Who", ", "];
	for (let i = 0; i < alerts.length; i++) {
		expect(alerts[i]!.groups ?? null).toEqual(want[i]);
		expect(alerts[i]!.suggestions).toEqual([wantFix[i]!]);
	}
});

test("groups survive a round-trip through JSON", () => {
	// An editor hands the alert back as JSON; the groups have to ride along
	// for the fix to come out the same.
	const alert =
		'{"Action":{"Name":"replace","Params":["$2 $1"]},"Match":"a b","Groups":["a","b"],"Check":"T.R"}';
	const got = parseAlert(alert, testConfig());
	expect(got.suggestions).toEqual(["b a"]);
	expect(got.error).toBe("");
});
