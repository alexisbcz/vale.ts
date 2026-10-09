/**
 * Reading Vale's own end-to-end suites.
 *
 * Upstream declares its expected behavior as YAML: one file per suite, each
 * case naming a working directory or bringing its own files, the arguments to
 * run with, the exit status, and the output expected. That is exactly the
 * contract this port has to meet, so the suites are read as written rather than
 * restated -- which also means an upgrade of the corpus is an upgrade of the
 * tests.
 *
 * This is a port of `internal/e2e/suite_test.go`.
 */

import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parse as parseYAML } from "yaml";
import { TOOL_ALTERNATIVES } from "./pinned.ts";

export interface Suite {
	/** Labels the suite; may contain a `/`. */
	name: string;
	/**
	 * The cases' working directory, relative to `testdata/`.
	 *
	 * A trailing `/*` means each case runs in a directory named after it.
	 */
	dir: string;
	/** Files every case starts from, keyed by name. */
	files: Record<string, string>;
	cases: Case[];
	/** The file this was read from. */
	path: string;
}

export interface Case {
	/** Unique within the suite; may contain a `/` to group related cases. */
	name: string;
	/** A note for the reader -- an issue number, or what the case pins down. */
	about: string;
	/** Overrides the suite's working directory. */
	dir: string;
	/** Files the case needs, written over the suite's. */
	files: Record<string, string>;
	/** Passed to Vale after the shared flags. */
	args: string[];
	/** The external converters this case's formats need. */
	requires: string[];
	/** A file in the working directory to pipe in. */
	stdin: string;
	/** Whether to run `vale sync` before the case. */
	sync: boolean;
	/** The expected exit status. */
	exit: number;
	/** The exact output expected; null when the case only asserts an excerpt. */
	want: string | null;
	/** An excerpt of the expected output. */
	contains: string;
	/** Strings the output must not contain. */
	absent: string[];
}

/** Reads every `*.yaml` in `dir`, in filename order. */
export function loadSuites(dir: string): Suite[] {
	const names = readdirSync(dir)
		.filter((n) => n.endsWith(".yaml"))
		.sort();
	if (names.length === 0) {
		throw new Error(`no suites found in ${dir}`);
	}

	const seen = new Map<string, string>();
	const suites: Suite[] = [];

	for (const name of names) {
		const full = path.join(dir, name);
		const raw = parseYAML(readFileSync(full, "utf8")) as Record<string, unknown>;
		const suite = readSuite(raw, full);
		validate(suite, seen);
		suites.push(suite);
	}

	return suites;
}

function readSuite(raw: Record<string, unknown>, from: string): Suite {
	const cases = Array.isArray(raw.cases) ? raw.cases : [];
	return {
		name: typeof raw.name === "string" ? raw.name : "",
		dir: typeof raw.dir === "string" ? raw.dir : "",
		files: asFiles(raw.files),
		cases: cases.map((c) => readCase(c as Record<string, unknown>)),
		path: from,
	};
}

function readCase(raw: Record<string, unknown>): Case {
	return {
		name: typeof raw.name === "string" ? raw.name : "",
		about: typeof raw.about === "string" ? raw.about : "",
		dir: typeof raw.dir === "string" ? raw.dir : "",
		files: asFiles(raw.files),
		args: asWords(raw.args),
		requires: asTools(raw.requires),
		stdin: typeof raw.stdin === "string" ? raw.stdin : "",
		sync: raw.sync === true,
		exit: typeof raw.exit === "number" ? raw.exit : 0,
		want: typeof raw.want === "string" ? raw.want : null,
		contains: typeof raw.contains === "string" ? raw.contains : "",
		absent: Array.isArray(raw.absent) ? raw.absent.map(String) : [],
	};
}

function asFiles(v: unknown): Record<string, string> {
	if (v === null || v === undefined || typeof v !== "object") return {};
	const out: Record<string, string> = {};
	for (const [k, body] of Object.entries(v as Record<string, unknown>)) {
		out[k] = typeof body === "string" ? body : String(body);
	}
	return out;
}

/**
 * Arguments, written either as one string or as a list.
 *
 * A string is split on spaces, honoring quotes, so that a case can write
 * `--output=line test.md`; a list passes its words through verbatim, which is
 * how an argument holding a space is given.
 */
export function asWords(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String);
	if (typeof v !== "string") return [];
	return splitArgs(v);
}

/** Splits a command line on spaces, keeping quoted runs together. */
export function splitArgs(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote = "";
	let any = false;

	for (const c of line) {
		if (quote !== "") {
			if (c === quote) quote = "";
			else current += c;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			any = true;
			continue;
		}
		if (c === " " || c === "\t" || c === "\n") {
			if (current !== "" || any) {
				out.push(current);
				current = "";
				any = false;
			}
			continue;
		}
		current += c;
	}
	if (current !== "" || any) out.push(current);

	return out;
}

function asTools(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String);
	if (typeof v !== "string") return [];
	return v
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

/** Whether a case brings its own files rather than running in a fixture. */
export function isInline(s: Suite, c: Case): boolean {
	return Object.keys(s.files).length > 0 || Object.keys(c.files).length > 0;
}

/** The directory a case runs in, under `testdata`. */
export function workdir(testdata: string, s: Suite, c: Case): string {
	if (isInline(s, c)) {
		// Two levels under `testdata/`, matching a checked-in fixture, so that
		// a relative `StylesPath` in an inline configuration resolves the same
		// way it would there.
		return path.join(testdata, "tmp", `${slug(s.name)}-${slug(c.name)}`);
	}

	const star = s.dir.endsWith("/*");
	const base = star ? s.dir.slice(0, -2) : s.dir;
	let dir = c.dir;
	if (dir === "" && star) dir = c.name;

	return path.join(testdata, base, dir);
}

/** Makes a name safe for a directory. */
export function slug(s: string): string {
	return s.replaceAll("/", "-").replaceAll(" ", "-");
}

/**
 * Rejects the mistakes that would otherwise make a case silently assert
 * nothing.
 */
function validate(s: Suite, seen: Map<string, string>): void {
	const where = path.basename(s.path);

	if (s.name === "") throw new Error(`${where}: missing \`name\``);
	if (s.cases.length === 0) throw new Error(`${where}: no cases`);

	const names = new Set<string>();
	for (const c of s.cases) {
		const full = `${s.name}/${c.name}`;

		if (c.name === "") {
			throw new Error(`${where}: a case is missing \`name\``);
		}
		if (names.has(c.name)) {
			throw new Error(`${where}: duplicate case "${c.name}"`);
		}
		if (c.args.length === 0 && !c.sync) {
			throw new Error(`${where}: "${c.name}" has no \`args\``);
		}
		if (c.want === null && c.contains === "" && c.absent.length === 0) {
			throw new Error(`${where}: "${c.name}" asserts nothing about the output`);
		}
		if (c.want !== null && c.contains !== "") {
			throw new Error(`${where}: "${c.name}" sets both \`want\` and \`contains\``);
		}
		if (c.dir !== "" && isInline(s, c)) {
			throw new Error(
				`${where}: "${c.name}" sets \`dir\` but builds its own files`,
			);
		}

		const other = seen.get(full);
		if (other !== undefined) {
			throw new Error(`${where}: "${full}" collides with ${other}`);
		}
		seen.set(full, where);
		names.add(c.name);
	}

	const other = seen.get(s.name);
	if (other !== undefined) {
		throw new Error(`${where}: suite "${s.name}" collides with a case in ${other}`);
	}
	seen.set(s.name, where);
}

/** The converters a case needs that are not installed. */
export function missingTools(required: readonly string[]): string[] {
	const absent: string[] = [];
	for (const name of required) {
		const options = TOOL_ALTERNATIVES[name] ?? [name];
		if (!options.some(onPath)) absent.push(name);
	}
	return absent;
}

const resolved = new Map<string, boolean>();

function onPath(cmd: string): boolean {
	const hit = resolved.get(cmd);
	if (hit !== undefined) return hit;

	const dirs = (process.env.PATH ?? "").split(path.delimiter);
	let found = false;
	for (const dir of dirs) {
		if (dir === "") continue;
		try {
			accessSync(path.join(dir, cmd), constants.X_OK);
			found = true;
			break;
		} catch {
			// Not here; try the next directory.
		}
	}

	resolved.set(cmd, found);
	return found;
}

/**
 * Normalizes output for comparison: trailing whitespace per line removed, and
 * a single trailing newline.
 */
export function clean(s: string): string {
	return `${s
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n+$/, "")}`;
}
