import { describe, expect, test } from "bun:test";
import { Existence, formatMessages, Manager } from "../src/index.ts";
import { managerWithStyles, testConfig, withStyles } from "./helpers.ts";

const demoRule =
	"extends: existence\nmessage: \"Avoid '%s'.\"\nlevel: warning\ntokens:\n  - obviously\n";

/** Loads a two-rule style under a configuration `cfgFn` sets up. */
function enabledTestManager(
	cfgFn: (cfg: ReturnType<typeof testConfig>) => void,
): Map<string, unknown> {
	const stylesPath = withStyles({
		"Demo/Wanted.yml": demoRule,
		"Demo/Unwanted.yml": demoRule,
	});

	const cfg = testConfig();
	cfg.addStylesPath(stylesPath);
	cfg.styles = ["Demo"];
	cfgFn(cfg);

	return Manager.create(cfg).rules();
}

describe("messages fill only the placeholders they have", () => {
	const cases: Array<[string, string[], string]> = [
		["Avoid using '%s'", ["foo", "bar"], "Avoid using 'foo'"],
		["Avoid using 'foo'", ["foo", "bar"], "Avoid using 'foo'"],
		["Use '%s', not '%s'", ["foo", "bar"], "Use 'foo', not 'bar'"],
	];

	for (const [input, args, want] of cases) {
		test(input, () => {
			const [msg] = formatMessages(input, input, ...args);
			expect(msg).toBe(want);
		});
	}
});

/**
 * `ruleForAlert` resolves an alert name to its defining rule by longest known
 * prefix: a consistency alert carries a matched term, and a nested rule's own
 * name spans subdirectories, so neither dot-count nor position can say where
 * the rule ends.
 */
test("ruleForAlert resolves by longest known prefix", () => {
	const cfg = testConfig();
	const mgr = new Manager(cfg);
	const stub = new Existence(cfg, { tokens: ["x"] }, "");
	mgr.addRule("Std.OxfordComma", stub);
	mgr.addRule("Std.dates.TimeFormat", stub);
	mgr.addRule("S.Consistency", stub);

	const cases: Array<[string, string]> = [
		["Std.OxfordComma", "Std.OxfordComma"],
		["Std.dates.TimeFormat", "Std.dates.TimeFormat"],
		["S.Consistency.center", "S.Consistency"],
		["Std.dates.TimeFormat.term", "Std.dates.TimeFormat"],
		["Un.Known.deep.name", "Un.Known"],
		["Un.Known", "Un.Known"],
	];
	for (const [input, want] of cases) {
		expect(mgr.ruleForAlert(input)).toBe(want);
	}
});

test("a rule cannot be added twice under one name", () => {
	const cfg = testConfig();
	const mgr = new Manager(cfg);
	const stub = new Existence(cfg, { tokens: ["x"] }, "");
	mgr.addRule("A.B", stub);
	expect(() => mgr.addRule("A.B", stub)).toThrow();
	expect(mgr.hasRule("A.B")).toBe(true);
});

test("a rule the configuration can never run is not compiled", () => {
	// Compiling is the expensive half of loading, and `= NO` was applied long
	// after it.
	const rules = enabledTestManager((cfg) => {
		cfg.sBaseStyles["*.md"] = ["Demo"];
		cfg.sChecks["*.md"] = { "Demo.Unwanted": false };
	});

	expect(rules.has("Demo.Wanted")).toBe(true);
	expect(rules.has("Demo.Unwanted")).toBe(false);
});

test("a style nothing is based on is not compiled at all", () => {
	const rules = enabledTestManager((cfg) => {
		cfg.sBaseStyles["*.md"] = ["Vale"];
	});

	expect(rules.has("Demo.Wanted")).toBe(false);
	expect(rules.has("Demo.Unwanted")).toBe(false);
});

test("a section can re-enable a rule that is off globally", () => {
	// The skip has to err toward compiling.
	const rules = enabledTestManager((cfg) => {
		cfg.gChecks["Demo.Unwanted"] = false;
		cfg.sBaseStyles["*.md"] = ["Demo"];
		cfg.sChecks["*.txt"] = { "Demo.Unwanted": true };
	});

	expect(rules.has("Demo.Unwanted")).toBe(true);
});

test("a rule's own setting wins over its style's", () => {
	const rules = enabledTestManager((cfg) => {
		cfg.sBaseStyles["*.md"] = ["Demo"];
		cfg.sChecks["*.md"] = { Demo: false, "Demo.Wanted": true };
	});

	expect(rules.has("Demo.Wanted")).toBe(true);
	expect(rules.has("Demo.Unwanted")).toBe(false);
});

test("a rule named on its own loads without BasedOnStyles", () => {
	const rules = enabledTestManager((cfg) => {
		cfg.sChecks["*.md"] = { "Demo.Wanted": true };
	});

	expect(rules.has("Demo.Wanted")).toBe(true);
	expect(rules.has("Demo.Unwanted")).toBe(false);
});

test("a loaded rule records the scopes and selectors it declares", () => {
	const sp = withStyles({
		"Demo/Scoped.yml":
			"extends: existence\nmessage: x\nscope:\n  - sentence & doc(h2 + p)\ntokens: [obviously]\n",
	});
	const cfg = testConfig();
	cfg.addStylesPath(sp);
	cfg.styles = ["Demo"];
	cfg.gBaseStyles = ["Demo"];

	const mgr = Manager.create(cfg);
	expect(mgr.hasRule("Demo.Scoped")).toBe(true);
	expect(mgr.hasScope("sentence")).toBe(true);
	expect(mgr.hasScope("paragraph")).toBe(false);
	expect(mgr.rulesForScope("sentence")).toEqual(["Demo.Scoped"]);
	expect(mgr.selections().length).toBe(1);
	expect(mgr.selections()[0]!.sel).toBe("h2 + p");
});

test("a rule's own level wins over its style's", () => {
	const sp = withStyles({ "Demo/Wanted.yml": demoRule });
	const cfg = testConfig();
	cfg.addStylesPath(sp);
	cfg.styles = ["Demo"];
	cfg.gBaseStyles = ["Demo"];
	cfg.ruleToLevel.Demo = "suggestion";
	cfg.ruleToLevel["Demo.Wanted"] = "error";

	const mgr = Manager.create(cfg);
	expect(mgr.rules().get("Demo.Wanted")?.fields().level).toBe("error");
});

test("a scalar override from the configuration reaches the rule", () => {
	const sp = withStyles({
		"Demo/Count.yml":
			"extends: occurrence\nmessage: 'too many (%d)'\nmax: 2\ntoken: ','\n",
	});
	const cfg = testConfig();
	cfg.addStylesPath(sp);
	cfg.styles = ["Demo"];
	cfg.gBaseStyles = ["Demo"];
	cfg.ruleToParams["Demo.Count"] = { max: "30" };

	const mgr = Manager.create(cfg);
	const rule = mgr.rules().get("Demo.Count");
	expect(rule).toBeDefined();
	// `max` is read through the field reads, which coerce the string.
	expect((rule as unknown as { max: number }).max).toBe(30);
});

test("a style the search path does not have is an error", () => {
	const [mgr] = managerWithStyles({});
	mgr.config.styles = ["Nope"];
	expect(() => Manager.create(mgr.config)).toThrow();
});

test("a test file beside a rule is not loaded as a rule", () => {
	const sp = withStyles({
		"Demo/Wanted.yml": demoRule,
		"Demo/Wanted.test.yml": "- name: a case\n  input: obviously\n",
		"Demo/_drafts/Draft.yml": "nonsense: true\n",
	});
	const cfg = testConfig();
	cfg.addStylesPath(sp);
	cfg.styles = ["Demo"];
	cfg.gBaseStyles = ["Demo"];

	const mgr = Manager.create(cfg);
	expect(mgr.hasRule("Demo.Wanted")).toBe(true);
	expect([...mgr.rules().keys()]).toEqual(["Demo.Wanted"]);
});
