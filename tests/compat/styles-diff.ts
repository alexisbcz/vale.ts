#!/usr/bin/env bun
/**
 * This port against the Go binary, on real styles and real documents.
 *
 * Vale's own end-to-end suite is a set of cases chosen to pin down behavior,
 * which means it is a set of cases someone thought of. This is the other half:
 * the style packages people actually install, run over whatever documents are
 * at hand, with both implementations compared line for line. A difference here
 * is a difference a user would have seen.
 *
 * ```
 * bun tests/compat/styles-diff.ts
 * bun tests/compat/styles-diff.ts --docs ~/some/docs
 * bun tests/compat/styles-diff.ts --styles Microsoft,Google
 * ```
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { CACHE, fetchCorpus, fetchReference, REFERENCE, TESTDATA } from "./fetch.ts";
import { SHARED_FLAGS } from "./pinned.ts";
import { clean } from "./suite.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(HERE, "..", "..", "packages", "cli", "src", "main.ts");

/**
 * The style packages to test against, and where each comes from.
 *
 * These are the ones in common use, and between them they exercise every rule
 * type: `existence` and `substitution` throughout, `capitalization` in Google
 * and Microsoft, `conditional` in Microsoft, `occurrence` in Google,
 * `readability` and `metric` in Readability, `consistency` in proselint,
 * `repetition` in write-good, and `sequence` in Joblint.
 */
const PACKAGES: Record<string, string> = {
	Microsoft: "https://github.com/errata-ai/Microsoft/releases/latest/download/Microsoft.zip",
	Google: "https://github.com/errata-ai/Google/releases/latest/download/Google.zip",
	proselint: "https://github.com/errata-ai/proselint/releases/latest/download/proselint.zip",
	"write-good": "https://github.com/errata-ai/write-good/releases/latest/download/write-good.zip",
	alex: "https://github.com/errata-ai/alex/releases/latest/download/alex.zip",
	Readability: "https://github.com/errata-ai/Readability/releases/latest/download/Readability.zip",
	Joblint: "https://github.com/errata-ai/Joblint/releases/latest/download/Joblint.zip",
};

export async function main(argv: readonly string[]): Promise<number> {
	const opts = parseOptions(argv);

	fetchCorpus();
	await fetchReference();
	const styles = await fetchStyles(opts.styles);

	const dir = prepare(styles, opts.docs);
	const docs = readdirSync(dir).filter((n) => /\.(md|txt|html)$/.test(n));
	if (docs.length === 0) {
		console.error(`no documents found under ${opts.docs}`);
		return 2;
	}

	const rules = countRules(path.join(dir, "styles"));
	console.log(
		`${styles.join(", ")}: ${rules} rules over ${docs.length} documents\n`,
	);

	let agreed = 0;
	let differed = 0;
	let ourAlerts = 0;

	for (const doc of docs.sort()) {
		const theirs = invoke(REFERENCE, [...SHARED_FLAGS, doc], dir);
		const ours = invoke("bun", [CLI, ...SHARED_FLAGS, doc], dir);

		ourAlerts += ours.lines.length;

		const only = diff(theirs.lines, ours.lines);
		if (only.missing.length === 0 && only.extra.length === 0) {
			agreed++;
			if (opts.verbose) {
				console.log(`  agree  ${doc}  (${ours.lines.length} alerts)`);
			}
			continue;
		}

		differed++;
		console.log(`  DIFFER ${doc}`);
		for (const line of only.missing.slice(0, opts.show)) {
			console.log(`         - ${line}`);
		}
		for (const line of only.extra.slice(0, opts.show)) {
			console.log(`         + ${line}`);
		}
		const more =
			only.missing.length + only.extra.length - Math.min(opts.show, only.missing.length) -
			Math.min(opts.show, only.extra.length);
		if (more > 0) console.log(`         ... and ${more} more`);
	}

	console.log("");
	console.log(
		`${agreed}/${docs.length} documents identical` +
			` (${((agreed / docs.length) * 100).toFixed(1)}%)` +
			`, ${ourAlerts} alerts`,
	);

	return differed === 0 ? 0 : 1;
}

/** Downloads the style packages, once, into the cache. */
async function fetchStyles(wanted: readonly string[]): Promise<string[]> {
	const into = path.join(CACHE, "styles");
	mkdirSync(into, { recursive: true });

	const got: string[] = [];
	for (const name of wanted) {
		const url = PACKAGES[name];
		if (url === undefined) {
			console.error(`unknown style package "${name}"`);
			continue;
		}
		const dir = path.join(into, name);
		if (existsSync(dir)) {
			got.push(name);
			continue;
		}

		const response = await fetch(url);
		if (!response.ok) {
			console.error(`downloading ${name}: ${response.status}`);
			continue;
		}
		const zip = path.join(into, `${name}.zip`);
		writeFileSync(zip, new Uint8Array(await response.arrayBuffer()));
		const result = spawnSync("unzip", ["-oq", zip, "-d", dir], {
			encoding: "utf8",
		});
		rmSync(zip, { force: true });
		if (result.status !== 0) {
			console.error(`unpacking ${name}: ${result.stderr ?? ""}`);
			continue;
		}
		got.push(name);
	}

	return got;
}

/** Builds a project with every style turned on and the documents beside it. */
function prepare(styles: readonly string[], docs: string): string {
	const dir = path.join(CACHE, "styles-diff");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(path.join(dir, "styles"), { recursive: true });

	// A package unpacks to `<name>/<name>/`, which is the style directory.
	for (const name of styles) {
		const from = path.join(CACHE, "styles", name, name);
		if (!existsSync(from)) continue;
		spawnSync("cp", ["-R", from, path.join(dir, "styles", name)]);
	}

	writeFileSync(
		path.join(dir, ".vale.ini"),
		[
			"StylesPath = styles",
			"MinAlertLevel = suggestion",
			"",
			"[*.{md,txt,html}]",
			`BasedOnStyles = ${styles.join(", ")}`,
			"",
		].join("\n"),
	);

	// The documents, copied flat and renamed, so that neither implementation
	// can be influenced by a path a section happens to match.
	let n = 0;
	const walk = (at: string): void => {
		for (const name of readdirSync(at)) {
			const full = path.join(at, name);
			if (statSync(full).isDirectory()) {
				// A styles directory holds rules rather than prose.
				if (name === "styles" || name === "node_modules" || name === ".git") {
					continue;
				}
				walk(full);
				continue;
			}
			if (!/\.(md|txt|html)$/.test(name)) continue;
			const body = readFileSync(full);
			if (body.length === 0 || body.length > 256 * 1024) continue;
			writeFileSync(path.join(dir, `doc${n++}${path.extname(name)}`), body);
		}
	};
	walk(docs);

	return dir;
}

function invoke(
	cmd: string,
	args: readonly string[],
	dir: string,
): { lines: string[] } {
	const result = spawnSync(cmd, args, {
		cwd: dir,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, NO_COLOR: "1" },
	});
	const out = clean(`${result.stdout ?? ""}${result.stderr ?? ""}`);
	return { lines: out === "" ? [] : out.split("\n") };
}

/**
 * Which lines one side has and the other does not.
 *
 * Compared as multisets rather than in order: both sides were run with
 * `--sort`, but a difference in one alert's column would otherwise cascade into
 * a difference in every line after it.
 */
function diff(
	theirs: readonly string[],
	ours: readonly string[],
): { missing: string[]; extra: string[] } {
	const counts = new Map<string, number>();
	for (const line of theirs) counts.set(line, (counts.get(line) ?? 0) + 1);

	const extra: string[] = [];
	for (const line of ours) {
		const n = counts.get(line) ?? 0;
		if (n > 0) counts.set(line, n - 1);
		else extra.push(line);
	}

	const missing: string[] = [];
	for (const [line, n] of counts) {
		for (let i = 0; i < n; i++) missing.push(line);
	}

	return { missing: missing.sort(), extra: extra.sort() };
}

function countRules(styles: string): number {
	if (!existsSync(styles)) return 0;
	let n = 0;
	const walk = (at: string): void => {
		for (const name of readdirSync(at)) {
			const full = path.join(at, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (name.endsWith(".yml") && !name.endsWith(".test.yml")) n++;
		}
	};
	walk(styles);
	return n;
}

interface Options {
	styles: string[];
	docs: string;
	verbose: boolean;
	show: number;
}

function parseOptions(argv: readonly string[]): Options {
	const opts: Options = {
		styles: Object.keys(PACKAGES),
		// Vale's own fixtures, which are a few hundred real documents in every
		// format it reads.
		docs: path.join(TESTDATA, "fixtures"),
		verbose: argv.includes("--verbose") || argv.includes("-v"),
		show: 8,
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--styles") {
			opts.styles = (argv[i + 1] ?? "").split(",").filter((s) => s !== "");
		} else if (argv[i] === "--docs") {
			opts.docs = argv[i + 1] ?? opts.docs;
		} else if (argv[i] === "--show") {
			opts.show = Number(argv[i + 1] ?? opts.show);
		}
	}
	return opts;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
