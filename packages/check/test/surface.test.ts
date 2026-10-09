import { expect, test } from "bun:test";
import type { Alert, File, NLPInfo } from "@vale-ts/core";
import type {
	Definition,
	Rule,
	ScopeMatcher,
	Selection,
	Solution,
} from "../src/index.ts";
import {
	docSelectors,
	Existence,
	fixAlert,
	Manager,
	newScope,
	parseAlert,
} from "../src/index.ts";
import { block, testConfig } from "./helpers.ts";

/**
 * The surface `@vale-ts/lint` is written against.
 *
 * Pinned as a test rather than left to the type checker alone, because a
 * rename that keeps the package compiling would still break the linter.
 */
test("the shapes the linter asks for are the ones exported", () => {
	const cfg = testConfig();

	// A manager can be created empty, or loaded from a configuration.
	const empty: Manager = new Manager(cfg);
	expect(empty.config).toBe(cfg);
	expect(empty.rules()).toBeInstanceOf(Map);
	expect(empty.hasRule("A.B")).toBe(false);
	expect(empty.hasScope("text")).toBe(false);
	expect(empty.rulesForScope("text")).toEqual([]);
	expect(empty.ruleForAlert("A.B.c")).toBe("A.B");

	const selections: Selection[] = empty.selections();
	expect(selections).toEqual([]);

	const loaded: Manager = Manager.create(cfg);
	expect(loaded.rules()).toBeInstanceOf(Map);

	// `assignNLP` answers with core's own info type.
	const info: NLPInfo = loaded.assignNLP({
		realExt: ".md",
		nlp: {
			lang: "en",
			endpoint: "",
			scope: "",
			tagging: false,
			segmentation: false,
			splitting: false,
		},
	} as unknown as File);
	expect(info.scope).toBe(".md");
	expect(info.tagging).toBe(false);

	// Scope matching.
	const matcher: ScopeMatcher = newScope(["~link"]);
	expect(matcher.excluded).toEqual(["link"]);
	expect(typeof matcher.matches).toBe("function");

	// The `doc(...)` terms of a scope, as written.
	expect(docSelectors("text & doc(h2 + p)")).toEqual(["h2 + p"]);

	// Resolving an alert's action.
	const suggestions: string[] = fixAlert(
		{
			action: { name: "edit", params: ["upper"] },
			suggestions: [],
			span: [0, 1],
			check: "T.R",
			description: "",
			link: "",
			message: "",
			severity: "warning",
			match: "x",
			line: 1,
		},
		cfg,
	);
	expect(suggestions).toEqual(["X"]);

	const solution: Solution = parseAlert(
		'{"Action":{"Name":"remove"},"Match":"x"}',
		cfg,
	);
	expect(solution.suggestions).toEqual([""]);
	expect(solution.error).toBe("");
});

test("a rule answers the three questions the linter asks", () => {
	const cfg = testConfig();

	// Built through the public constructor rather than the manager, so what is
	// pinned is the interface rather than the loading path.
	const rule: Rule = new Existence(cfg, { tokens: ["x"], message: "m" }, "");

	const fields: Definition = rule.fields();
	expect(fields.name).toBe("");
	expect(fields.scope).toEqual([]);
	expect(fields.action).toEqual({ name: "", params: [] });
	expect(typeof rule.pattern()).toBe("string");

	const alerts: Alert[] = rule.run(block("a y here"), null, cfg);
	expect(alerts.length).toBe(0);
	expect(rule.run(block("an x here"), null, cfg).length).toBe(1);
});
