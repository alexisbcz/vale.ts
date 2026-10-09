import { expect, test } from "bun:test";
import { filter, filterView, Manager, newDefinition } from "../src/index.ts";
import { testConfig, withStyles } from "./helpers.ts";

const rule = (level: string): string =>
	`extends: existence\nmessage: "Avoid '%s'."\nlevel: ${level}\ntokens:\n  - obviously\n`;

function loaded(expression: string): Manager {
	const sp = withStyles({
		"Demo/Loud.yml": rule("error"),
		"Demo/Quiet.yml": rule("suggestion"),
	});
	const cfg = testConfig();
	cfg.addStylesPath(sp);
	cfg.styles = ["Demo"];
	cfg.gBaseStyles = ["Demo"];
	cfg.flags.filter = expression;
	return Manager.create(cfg);
}

test("a filter's fields are the ones the documentation names", () => {
	const view = filterView(
		newDefinition({ name: "A.B", level: "error", scope: ["text"] }),
	);
	expect(view.Name).toBe("A.B");
	expect(view.Level).toBe("error");
	expect(view.Scope).toEqual(["text"]);
});

test("no filter keeps every loaded rule", () => {
	const mgr = loaded("");
	expect([...mgr.rules().keys()].sort()).toEqual(["Demo.Loud", "Demo.Quiet"]);
});

test("a filter chooses from what the configuration already loaded", () => {
	const mgr = loaded('.Level == "error"');
	expect([...mgr.rules().keys()]).toEqual(["Demo.Loud"]);
});

test("a filter on the name selects one rule", () => {
	const mgr = loaded('.Name == "Demo.Quiet"');
	expect([...mgr.rules().keys()]).toEqual(["Demo.Quiet"]);
});

test("a filter that reads `.Level` lowers the reporting floor", () => {
	const sp = withStyles({ "Demo/Quiet.yml": rule("suggestion") });
	const cfg = testConfig();
	cfg.addStylesPath(sp);
	cfg.styles = ["Demo"];
	cfg.gBaseStyles = ["Demo"];
	cfg.minAlertLevel = 2;
	cfg.flags.filter = '.Level == "suggestion"';

	const mgr = Manager.create(cfg);
	expect([...mgr.rules().keys()]).toEqual(["Demo.Quiet"]);
	expect(cfg.minAlertLevel).toBe(0);
});

test("a filter with no matches leaves nothing to run", () => {
	const mgr = loaded('.Level == "warning"');
	expect(mgr.rules().size).toBe(0);
});

test("filter() reads the manager's own rules", () => {
	const mgr = loaded("");
	mgr.config.flags.filter = '.Name contains "Loud"';
	expect([...filter(mgr).keys()]).toEqual(["Demo.Loud"]);
});
