/**
 * The `--filter` flag: an expression that chooses which of the loaded rules
 * actually run.
 *
 * The order is always `.vale.ini` then filter, and the filter has the last
 * say -- which means a filtered result can only ever be a subset of what the
 * configuration already loaded.
 */

import { readFileSync } from "node:fs";
import {
	compileExpr,
	findAsset,
	fileExists,
	LEVEL_TO_INT,
} from "@vale-ts/core";
import type { Definition, Rule } from "./definition.ts";
import type { Manager } from "./manager.ts";

/**
 * A rule's definition as the filter sees it.
 *
 * The field names are Go's, because `--filter` strings are user-visible and
 * documented as `.Name`, `.Level`, `.Scope` and so on.
 */
export function filterView(def: Definition): Record<string, unknown> {
	return {
		Name: def.name,
		Level: def.level,
		Scope: def.scope,
		Message: def.message,
		Description: def.description,
		Extends: def.extends,
		Link: def.link,
		Limit: def.limit,
	};
}

/** The rules `mgr` should keep, after applying its configuration's filter. */
export function filter(mgr: Manager): Map<string, Rule> {
	const stringOrPath = mgr.config.flags.filter;
	if (stringOrPath === "") return mgr.rules();

	let source: string;
	if (fileExists(stringOrPath)) {
		// A path to a filter file.
		try {
			source = readFileSync(stringOrPath, "utf8");
		} catch (err) {
			throw new Error(
				`failed to read filter '${stringOrPath}': ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else {
		const found = findAsset(mgr.config, stringOrPath);
		if (found !== "") {
			try {
				source = readFileSync(found, "utf8");
			} catch (err) {
				throw new Error(
					`failed to read filter '${found}': ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else {
			// Otherwise the flag is the expression itself.
			source = stringOrPath;
		}
	}

	const views = new Map<Record<string, unknown>, string>();
	const rules: Array<Record<string, unknown>> = [];
	for (const [name, rule] of mgr.rules()) {
		const view = filterView(rule.fields());
		views.set(view, name);
		rules.push(view);
	}

	const code = `filter(Rules, {${source}})`;
	const output = compileExpr(code).run({ Rules: rules });
	if (!Array.isArray(output)) return mgr.rules();

	const filtered = new Map<string, Rule>();
	for (const entry of output) {
		const view = entry as Record<string, unknown>;
		const own = views.get(view);
		const name = mgr.ruleForAlert(own ?? String(view.Name ?? ""));

		// What the filter returns is not simply what should run -- it depends
		// on the filter's *intent*. A filter that only sets `.Level` could
		// return rules that match the new level but are switched off in the
		// `.vale.ini`.
		if (code.includes(".Level")) {
			const lvl = LEVEL_TO_INT[String(view.Level ?? "")];
			if (lvl !== undefined && lvl < mgr.config.minAlertLevel) {
				mgr.config.minAlertLevel = lvl;
			}
		}

		const rule = mgr.rules().get(name);
		if (rule !== undefined) filtered.set(name, rule);
	}

	return filtered;
}
