/**
 * Reading a data file through a view.
 *
 * A data file is not prose, so what is prose in it has to be said: a view's
 * selectors name the values to lint, and the markup each one is written in.
 * The values themselves are linted by `scoped.ts`, which moves each one's
 * alerts back to where it sits in the file.
 *
 * Two readings come for free. A data file with a grammar -- YAML or TOML --
 * has comments, and those are prose whatever the view says, so they are read
 * as a source file's. And a Vale rule is a YAML file Vale knows the shape of:
 * its message and description are prose, and its tokens, swaps and exceptions
 * are patterns, often wrong on purpose.
 */

import type { Config, File, ScopedValues } from "@vale-ts/core";
import {
	newE100,
	newE201FromTarget,
	View,
} from "@vale-ts/core";
import { parse as parseYAML } from "yaml";
import type { CodeHost } from "./code.ts";
import { lintCode } from "./code.ts";
import { hasLanguage } from "./code/index.ts";

/** What a data reader needs from the linter. */
export interface DataHost extends CodeHost {
	config: Config;
	lintScopedValues(f: File, values: readonly ScopedValues[]): void;
}

/**
 * Whether a `textfsm` or `dasel` view reads this file.
 *
 * Either reads the whole file itself, so the file's own format does not
 * matter; a tree-sitter view is reached through the code path instead.
 */
export function hasView(cfg: Config, f: File): boolean {
	for (const [syntax, view] of Object.entries(cfg.views)) {
		if (view.engine === "tree-sitter") continue;
		if (cfg.sectionApplies(syntax, f.held, f.path)) return true;
	}
	return false;
}

/** Whether a tree-sitter view reads this file. */
export function hasCodeView(cfg: Config, f: File): boolean {
	for (const [syntax, view] of Object.entries(cfg.views)) {
		if (view.engine !== "tree-sitter") continue;
		if (cfg.sectionApplies(syntax, f.held, f.path)) return true;
	}
	return false;
}

/** The fields of a Vale rule that hold prose. */
const RULE_PROSE = ["message", "description"];

/** What opens a Vale rule: a top-level `extends`. */
const EXTENDS_KEY = /^extends:[ \t]*\S/m;

/** Whether `f` is a Vale rule, which a YAML file with a top-level `extends` is. */
export function isRuleFile(f: File): boolean {
	return f.normedExt === ".yml" && EXTENDS_KEY.test(f.content);
}

/**
 * Lints a Vale rule's message and description, and nothing else.
 *
 * Its tokens, swaps and exceptions are patterns, and often wrong on purpose.
 */
export function lintRule(host: DataHost, f: File): void {
	let fields: unknown;
	try {
		fields = parseYAML(f.content);
	} catch {
		// Not a rule Vale could load either; there is nothing to lint.
		return;
	}
	if (fields === null || typeof fields !== "object") return;

	const scopes = RULE_PROSE.filter((key) => key in fields).map((key) => ({
		name: "",
		expr: key,
		type: "",
	}));
	if (scopes.length === 0) return;

	const view = new View({ engine: "dasel", scopes });

	let found: ScopedValues[];
	try {
		found = view.apply(f);
	} catch (err) {
		throw newE100(f.path, err);
	}
	host.lintScopedValues(f, found);
}

/** Reads a data file through the view that applies to it. */
export function lintData(host: DataHost, f: File): void {
	const cfg = host.config;

	for (const [syntax, view] of Object.entries(cfg.views)) {
		if (view.engine === "tree-sitter") continue;
		if (!cfg.sectionApplies(syntax, f.held, f.path)) continue;

		// The view says which values are prose. The file's comments are prose
		// whatever it says, and are read as a source file's.
		lintDataComments(host, f);

		let found: ScopedValues[];
		try {
			found = view.apply(f);
		} catch (err) {
			throw newE201FromTarget(
				`${f.path}: ${err instanceof Error ? err.message : String(err)}`,
				`[${syntax}] View`,
				cfg.rootINI,
			);
		}
		host.lintScopedValues(f, found);
		return;
	}
}

/**
 * Lints the comments of a data file that has a grammar -- YAML or TOML -- and
 * does nothing for one with no comments to read.
 */
export function lintDataComments(host: DataHost, f: File): void {
	if (hasLanguage(f.realExt)) lintCode(host, f);
}

/**
 * Lints the file's text as code in the given language, so that its comments
 * are the prose.
 */
export function lintAsCode(host: CodeHost, f: File, ext: string): void {
	const realExt = f.realExt;
	const normedExt = f.normedExt;
	f.realExt = ext;
	f.normedExt = ext;
	try {
		lintCode(host, f);
	} finally {
		f.realExt = realExt;
		f.normedExt = normedExt;
	}
}
