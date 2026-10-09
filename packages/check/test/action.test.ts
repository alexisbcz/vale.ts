import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_DIR, type Action, newAlert } from "@vale-ts/core";
import {
	checkAction,
	Existence,
	editSteps,
	fixAlert,
	Manager,
	newDefinition,
	resolveFix,
	Spelling,
} from "../src/index.ts";
import { testConfig, withStyles } from "./helpers.ts";

/** A rule carrying nothing but a definition, for `checkAction`. */
function ruleWith(action: Action, name = "RedHat.Rule"): Existence {
	const cfg = testConfig();
	return new Existence(cfg, { tokens: ["x"], name, action }, "");
}

describe("checkAction", () => {
	const stylesPath = withStyles({
		"RedHat/Present.tengo": 'prefix := "x"\nsuggestions := [prefix]\n',
	});
	const cfg = testConfig();
	cfg.addStylesPath(stylesPath);

	const cases: Array<[string, Action, string]> = [
		["none", { name: "", params: [] }, ""],
		["replace", { name: "replace", params: [] }, ""],
		["remove", { name: "remove", params: [] }, ""],
		["unknown", { name: "nothing", params: [] }, "unknown action 'nothing'"],
		["convert", { name: "convert", params: ["simple"] }, ""],
		[
			"convert bare",
			{ name: "convert", params: [] },
			"'convert' takes one parameter: simple",
		],
		["suggest script", { name: "suggest", params: ["Present.tengo"] }, ""],
		["suggest spellings", { name: "suggest", params: ["spellings"] }, ""],
		[
			"suggest bare",
			{ name: "suggest", params: [] },
			"'suggest' takes one parameter",
		],
		[
			"suggest missing",
			{ name: "suggest", params: ["Absent.tengo"] },
			"script 'Absent.tengo' not found",
		],
		["edit trim", { name: "edit", params: ["trim_right", ".?!"] }, ""],
		["edit bare", { name: "edit", params: [] }, "'edit' needs an operation"],
		[
			"edit unknown",
			{ name: "edit", params: ["strip", ".?!"] },
			"unknown edit 'strip'",
		],
		[
			"edit arity",
			{ name: "edit", params: ["regex", "a"] },
			"'regex' takes 2 parameter(s)",
		],
		[
			"edit bad index",
			{ name: "edit", params: ["split", " ", "one"] },
			"'split' index 'one' is not a number",
		],
		[
			"edit pipeline",
			{ name: "edit", params: ["trim_right", "!", "lower", "wrap", "`"] },
			"",
		],
		[
			"edit pipeline short",
			{ name: "edit", params: ["lower", "wrap"] },
			"'wrap' takes 1 parameter(s)",
		],
		[
			"edit pipeline unknown",
			{ name: "edit", params: ["lower", "shout"] },
			"unknown edit 'shout'",
		],
	];

	for (const [name, action, want] of cases) {
		test(name, () => {
			let got = "";
			try {
				checkAction(cfg, ruleWith(action));
			} catch (err) {
				got = err instanceof Error ? err.message : String(err);
			}
			expect(got).toBe(want);
		});
	}

	test("a bad pattern in a regex step is refused", () => {
		expect(() =>
			checkAction(cfg, ruleWith({ name: "edit", params: ["regex", "(", "x"] })),
		).toThrow();
	});
});

test("a spelling rule's bare `suggest` means its dictionaries", () => {
	const cfg = testConfig();
	const rule = new Spelling(
		cfg,
		{ name: "T.S", message: "'%s'?", action: { name: "suggest" } },
		"internal",
	);
	expect(() => checkAction(cfg, rule)).not.toThrow();
});

test("a rule with a bad action fails to load, naming the file", () => {
	const sp = withStyles({
		"T/Bad.yml":
			"extends: existence\nmessage: \"'%s' -> '%s'\"\n" +
			"action:\n  name: edit\n  params:\n    - strip\n    - '.?!'\ntokens:\n  - foo\n",
	});
	const cfg = testConfig();
	cfg.addStylesPath(sp);
	const mgr = new Manager(cfg);

	let message = "";
	try {
		mgr.addRuleFromFile("T.Bad", join(sp, "T", "Bad.yml"));
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}
	expect(message).toContain("unknown edit 'strip'");
});

describe("what fixAlert refuses", () => {
	const cases: Array<[Action, string]> = [
		[{ name: "convert", params: [] }, "no parameters"],
		[{ name: "convert", params: ["upper"] }, "unknown conversion 'upper'"],
		[{ name: "edit", params: ["strip", "!"] }, "unknown edit 'strip'"],
		[{ name: "edit", params: ["trim"] }, "'trim' takes 1 parameter(s)"],
		[{ name: "nothing", params: [] }, "unknown action 'nothing'"],
	];

	for (const [action, want] of cases) {
		test(want, () => {
			let message = "";
			try {
				fixAlert(newAlert({ match: "x", action }), null);
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).toBe(want);
		});
	}
});

test("an edit regex step runs on the rules' own engine", () => {
	const got = fixAlert(
		newAlert({
			match: "qux",
			action: { name: "edit", params: ["regex", "(?<=q)ux", "UX"] },
		}),
		null,
	);
	expect(got).toEqual(["qUX"]);
});

describe("the edit operations", () => {
	const cases: Array<[string, string[], string]> = [
		["foo!", ["trim_right", "!"], "foo"],
		["  foo", ["trim_left", " "], "foo"],
		["*foo*", ["trim", "*"], "foo"],
		["the the", ["truncate", " "], "the"],
		["a-b-c", ["split", "-", "2"], "c"],
		["snake_case", ["regex", String.raw`(\w+)_(\w+)`, "$1-$2"], "snake-case"],
		["endpoint's", ["replace", "'", ""], "endpoints"],
		["Overview.", ["remove", ".?!"], "Overview"],
		["a—b", ["remove", " "], "a—b"],
	];

	for (const [match, params, want] of cases) {
		test(`${params.join(" ")} on ${match}`, () => {
			expect(
				fixAlert(newAlert({ match, action: { name: "edit", params } }), null),
			).toEqual([want]);
		});
	}
});

describe("an edit pipeline folds its operations", () => {
	const cases: Array<[string, string[], string]> = [
		["Wow!", ["trim_right", "!", "lower"], "wow"],
		["foo", ["wrap", "`"], "`foo`"],
		["`foo`", ["unwrap", "`"], "foo"],
		["foo", ["prefix", "“", "suffix", "”"], "“foo”"],
		["the api", ["upper"], "THE API"],
		["THE API", ["lower"], "the api"],
		["a title here", ["title"], "A Title Here"],
		["A Title Here", ["sentence"], "A title here"],
		["FooBar", ["simple"], "foo bar"],
		["FooBar", ["kebab"], "foo-bar"],
		["FooBar", ["snake"], "foo_bar"],
		["foo bar", ["camel"], "fooBar"],
		["foo bar", ["pascal"], "FooBar"],
		[
			"Section Title.",
			["trim_right", ".", "sentence", "wrap", "*"],
			"*Section title*",
		],
	];

	for (const [match, params, want] of cases) {
		test(`${params.join(" ")} on ${match}`, () => {
			expect(
				fixAlert(newAlert({ match, action: { name: "edit", params } }), null),
			).toEqual([want]);
		});
	}
});

test("editSteps reads a flat list as a pipeline", () => {
	expect(
		editSteps(["trim_right", "!", "lower", "replace", "a", "b", "title"]),
	).toEqual([["trim_right", "!"], ["lower"], ["replace", "a", "b"], ["title"]]);

	// An argument that happens to name an operation is still an argument.
	expect(editSteps(["replace", "lower", "upper"]).length).toBe(1);
});

test("a nested params list flattens when the rule loads", () => {
	const sp = withStyles({
		"T/Steps.yml":
			"extends: existence\nmessage: \"'%s' -> '%s'\"\n" +
			"action:\n  name: edit\n  params:\n    - [trim_right, '!']\n    - [lower]\n" +
			"    - [wrap, '`']\ntokens:\n  - 'Wow!'\n",
	});
	const cfg = testConfig();
	cfg.addStylesPath(sp);
	const mgr = new Manager(cfg);

	const path = join(sp, "T", "Steps.yml");
	const [rule] = mgr.compileCheck(readFileSync(path, "utf8"), "T.Steps", path);
	expect(rule.fields().action.params).toEqual([
		"trim_right",
		"!",
		"lower",
		"wrap",
		"`",
	]);
});

test("resolveFix fills in an alert's suggestions, and leaves a bare one alone", () => {
	const a = newAlert({
		check: "T.R",
		match: "foo!",
		action: { name: "edit", params: ["trim_right", "!"] },
	});
	resolveFix(a, null);
	expect(a.suggestions).toEqual(["foo"]);

	const bare = newAlert({ check: "T.R", match: "foo" });
	resolveFix(bare, null);
	expect(bare.suggestions).toEqual([]);
});

test("a definition's default action is empty", () => {
	expect(newDefinition().action).toEqual({ name: "", params: [] });
	expect(ACTION_DIR.endsWith("actions")).toBe(true);
});
