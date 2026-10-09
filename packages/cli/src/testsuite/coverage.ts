/**
 * Which rules no case made fire.
 *
 * A rule that matches nothing loads, runs, and reports success, so a case that
 * expects nothing from it proves nothing. The rules under the given paths are
 * listed so that `uncovered` can say which never produced an alert.
 */

import { isTestFile, tryParseLenient, walk } from "@vale-ts/core";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { Result } from "./run.ts";
import { isolatedName } from "./run.ts";

/** Whether the file is a rule: YAML with an `extends`, and not a test file. */
export function isRule(file: string): boolean {
	const name = path.basename(file);
	if (
		isTestFile(name) ||
		(!name.endsWith(".yml") && !name.endsWith(".yaml"))
	) {
		return false;
	}

	// Foreign YAML is not a rule, as `loadCases` treats it.
	const parsed = tryParseLenient(readFileSync(file, "utf8"));
	if (parsed === null || typeof parsed !== "object") return false;
	const extend = (parsed as Record<string, unknown>).extends;
	return extend !== undefined && extend !== "";
}

/**
 * Names every rule under the given files and directories, the way a project run
 * would name it.
 */
export function ruleNames(
	paths: readonly string[],
	search: readonly string[],
): string[] {
	const roots = paths.length === 0 ? ["."] : paths;
	const names: string[] = [];

	for (const root of roots) {
		const info = statSync(root);
		if (!info.isDirectory()) {
			if (isRule(root)) names.push(isolatedName(root, search));
			continue;
		}

		walk(root, (entry) => {
			if (entry.isDirectory) {
				// A dot or underscore directory is inert to the style loader
				// too: what is parked there is not a rule that could fire.
				if (
					entry.path !== root &&
					(entry.name.startsWith(".") || entry.name.startsWith("_"))
				) {
					return false;
				}
				return true;
			}
			if (isRule(entry.path)) names.push(isolatedName(entry.path, search));
			return true;
		});
	}

	return names.sort();
}

/** The rules that produced no alert in any result. */
export function uncovered(
	rules: readonly string[],
	results: readonly Result[],
): string[] {
	const fired = new Set<string>();

	for (const r of results) {
		for (const line of r.got.split("\n")) {
			// `line:col:check:message`; the check is the third field.
			const parts = line.split(":");
			if (parts.length >= 4) fired.add(parts[2] as string);
		}
	}

	return rules.filter((rule) => !fired.has(rule));
}
