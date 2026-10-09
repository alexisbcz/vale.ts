/**
 * The test cases a configuration keeps beside its rules.
 *
 * A rule is a small program, and nobody maintains a significant Vale
 * configuration without some way to ask "does this still fire where I think it
 * does?". The cases are YAML, they live next to what they test, and they are
 * run by `vale test`. See #1122.
 *
 * This is a port of `internal/testsuite`, which has no package of its own in
 * this port: `vale test` is the only thing that reads these files.
 */

import {
	isTestFile,
	newE201FromPosition,
	parseLenient,
	walk,
	YAMLError,
} from "@vale-ts/core";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";

/** One document and what linting it must produce. */
export interface Case {
	/** Identifies the case in the report. Required, and unique within its file. */
	name: string;

	/**
	 * A note for the reader -- an issue number, or what the case is really
	 * pinning down. Never asserted on.
	 */
	about: string;

	/** The document to lint. */
	input: string;

	/** The extension `input` is read as, with or without the dot. */
	format: string;

	/**
	 * Names a View, found under a search path's `config/views`, to read `input`
	 * through.
	 *
	 * An isolated case loads nothing from the project's configuration, and that
	 * includes the View that gives a rule its scope: a rule scoped to `subject`
	 * sees no subject without one. With it, the case runs the way the project's
	 * section would run it, and the cases of a View's rules can live beside
	 * them.
	 */
	view: string;

	/**
	 * Isolates the case to a single rule, named by a path relative to the test
	 * file.
	 *
	 * Nothing else is loaded -- not the rest of the style, not the project's
	 * configuration -- so the case says exactly what the rule does and nothing
	 * about what a run would surface. Without it, the case is linted by the
	 * configuration a `vale` run in this directory would use, which is what
	 * tells you whether the rule reaches real documents at all.
	 */
	rule: string;

	/**
	 * The exact output expected. `null` when unset, so that an empty block
	 * asserts "no alerts at all" rather than going unasserted.
	 */
	want: string | null;
	/** Excerpts of the expected output. */
	contains: string[];
	/** What must not appear. */
	absent: string[];

	/** The file this case was read from. */
	path: string;
}

/** The extension `input` is linted as, dot included. */
export function caseExt(c: Case): string {
	const format = c.format === "" ? "md" : c.format;
	return `.${format.replace(/^\./, "")}`;
}

/** One string or a list of them, so `contains: T.Rule` reads the same way. */
function strings(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.map(String);
	return [String(value)];
}

/** Reports a case that cannot be run, rather than one that fails. */
function validate(c: Case, seen: Set<string>): void {
	const where = `${path.basename(c.path)}: "${c.name}"`;

	if (c.name === "") {
		throw new Error(`${path.basename(c.path)}: every case needs a name`);
	}
	if (seen.has(c.name)) throw new Error(`${where}: duplicate name`);
	seen.add(c.name);

	// A case that asserts nothing passes whatever the rule does, which is worse
	// than having no case at all: it reads as coverage.
	if (c.want === null && c.contains.length === 0 && c.absent.length === 0) {
		throw new Error(`${where}: needs one of \`want\`, \`contains\`, or \`absent\``);
	}
}

/** Reads one case out of its mapping. */
function readCase(raw: unknown, file: string, defaultRule: string): Case {
	const map = (raw ?? {}) as Record<string, unknown>;
	return {
		name: map.name === undefined ? "" : String(map.name),
		about: map.about === undefined ? "" : String(map.about),
		input: map.input === undefined ? "" : String(map.input),
		format: map.format === undefined ? "" : String(map.format),
		view: map.view === undefined ? "" : String(map.view),
		rule:
			map.rule === undefined || map.rule === null
				? defaultRule
				: String(map.rule),
		want: map.want === undefined || map.want === null ? null : String(map.want),
		contains: strings(map.contains),
		absent: strings(map.absent),
		path: file,
	};
}

const RULE_KEY = /^extends:/m;
const TESTS_KEY = /^tests:/m;

/**
 * go-yaml's wording for the parse errors a rule's cases actually hit.
 *
 * The two parsers diagnose the same mistakes and name them differently, and
 * the one people hit -- an unquoted `input: Note: this` -- has an answer in
 * Vale's own documentation under go-yaml's wording. Anything not listed keeps
 * the message the parser gave, which is the honest thing to show.
 */
const YAML_MESSAGES: Record<string, string> = {
	"Nested mappings are not allowed in compact mappings":
		"mapping values are not allowed in this context",
	"Implicit keys need to be on a single line":
		"mapping values are not allowed in this context",
};

/** Places a YAML error at the line the parser names. */
function yamlError(file: string, err: unknown): Error {
	const line = err instanceof YAMLError ? err.line : 1;
	const raw = err instanceof Error ? err.message : String(err);

	// The parser puts the position and an excerpt in the message; the line is
	// carried separately, so both are taken off the end.
	const stripped = raw.replace(/ at line \d+, column \d+:[\s\S]*$/, "");

	return newE201FromPosition(goYAMLMessage(stripped), file, line);
}

/** The go-yaml wording for a message, when one is known. */
function goYAMLMessage(msg: string): string {
	return YAML_MESSAGES[msg] ?? msg;
}

/**
 * Reads the cases in one file.
 *
 * A `.test.yml` holds a sequence of cases and is validated strictly -- it
 * exists for no other reason. Any other YAML file is considered only if it is a
 * rule carrying its own cases: a mapping with `extends` and a `tests` sequence.
 * Everything else -- workflows, configs, data files -- is silently not ours, so
 * `vale test` can walk a whole repository without tripping on YAML it has no
 * business reading.
 */
export function loadCases(file: string): Case[] {
	const body = readFileSync(file, "utf8");

	if (isTestFile(path.basename(file))) {
		let parsed: unknown;
		try {
			parsed = parseLenient(body);
		} catch (err) {
			throw yamlError(file, err);
		}
		const list = Array.isArray(parsed) ? parsed : [];
		return finish(
			list.map((raw) => readCase(raw, file, "")),
			file,
		);
	}

	let rule: { extends?: unknown; tests?: unknown };
	try {
		rule = (parseLenient(body) ?? {}) as { extends?: unknown; tests?: unknown };
	} catch (err) {
		// A rule carrying cases that does not parse is a mistake in it -- an
		// unquoted `input: Note: this`, say -- and skipping it would drop its
		// cases from the run unannounced. Anything else that does not parse is
		// not ours: `.eslintrc.yml` has an `extends` too.
		if (RULE_KEY.test(body) && TESTS_KEY.test(body)) throw yamlError(file, err);
		return [];
	}

	const tests = Array.isArray(rule.tests) ? rule.tests : [];
	if (rule.extends === undefined || rule.extends === "" || tests.length === 0) {
		return [];
	}

	// An in-source case tests the rule it lives in: `rule` defaults to the file
	// itself, which also makes it isolated -- the doctest reading.
	return finish(
		tests.map((raw) => readCase(raw, file, path.basename(file))),
		file,
	);
}

function finish(cases: Case[], _file: string): Case[] {
	const seen = new Set<string>();
	for (const c of cases) validate(c, seen);
	return cases;
}

/**
 * Resolves what to run.
 *
 * A file is taken as given, a directory is searched, and no argument at all
 * searches the working directory -- which finds a style's cases wherever the
 * `StylesPath` happens to be.
 */
export function findCases(paths: readonly string[]): string[] {
	const roots = paths.length === 0 ? ["."] : paths;
	const found: string[] = [];

	for (const root of roots) {
		const info = statSync(root);
		if (!info.isDirectory()) {
			found.push(root);
			continue;
		}
		collect(root, found);
	}

	return found.sort();
}

function collect(root: string, found: string[]): void {
	walk(root, (entry) => {
		if (entry.isDirectory) {
			// A dot directory is somebody else's -- `.git`, `.venv`. The root
			// itself is exempt, since `vale test .vale/tests` names one.
			if (entry.path !== root && entry.name.startsWith(".")) return false;
			return true;
		}
		if (
			isTestFile(entry.name) ||
			entry.name.endsWith(".yml") ||
			entry.name.endsWith(".yaml")
		) {
			found.push(entry.path);
		}
		return true;
	});
}
