#!/usr/bin/env bun
/**
 * How fast this port is, next to the Go binary.
 *
 * Not a micro-benchmark: it lints a real corpus with a real style, because
 * that is the shape of the work and because the thing most likely to dominate
 * -- the literal prefilter that rules a pattern out before the engine sees it
 * -- only shows up at that scale. A style of 500 rules against a document the
 * rules mostly cannot match is the case Vale is tuned for, and the case a port
 * is most likely to get wrong.
 *
 * ```
 * bun tests/compat/bench.ts                     # the bundled corpus
 * bun tests/compat/bench.ts --styles DIR --docs DIR
 * bun tests/compat/bench.ts --runs 5
 * ```
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fetchReference, REFERENCE, TESTDATA } from "./fetch.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(HERE, "..", "..", "packages", "cli", "src", "main.ts");

interface Options {
	styles: string;
	docs: string;
	runs: number;
	reference: boolean;
}

export async function main(argv: readonly string[]): Promise<number> {
	const opts = parseOptions(argv);
	if (opts.reference) await fetchReference();

	const dir = prepare(opts);
	const size = corpusSize(dir);
	const rules = countRules(path.join(dir, "styles"));

	console.log(
		`corpus: ${(size / 1024).toFixed(0)} KB across ${countDocs(dir)} documents, ` +
			`${rules} rules\n`,
	);

	const ours = time(opts.runs, () => invoke("bun", [CLI, "--no-exit", "."], dir));
	report("vale-ts", ours, size);

	if (opts.reference) {
		const theirs = time(opts.runs, () =>
			invoke(REFERENCE, ["--no-exit", "."], dir),
		);
		report("vale (Go)", theirs, size);
		console.log(
			`\nthis port is ${(median(ours) / median(theirs)).toFixed(1)}x the Go binary's wall time`,
		);
	}

	return 0;
}

/** Builds the project the benchmark lints, and returns its directory. */
function prepare(opts: Options): string {
	const dir = path.join(HERE, ".cache", "bench");
	mkdirSync(dir, { recursive: true });

	// A configuration naming every style in the corpus, so the run pays for the
	// whole rule set rather than for one style.
	const styles = readdirSync(path.join(opts.styles)).filter((n) =>
		statSync(path.join(opts.styles, n)).isDirectory(),
	);
	const named = styles.filter((n) => n !== "config");

	writeFileSync(
		path.join(dir, ".vale.ini"),
		[
			`StylesPath = ${path.resolve(opts.styles)}`,
			"MinAlertLevel = suggestion",
			"",
			"[*.{md,txt}]",
			`BasedOnStyles = ${named.join(", ")}`,
			"",
		].join("\n"),
	);

	// The documents, copied flat so that the walk is over one directory.
	let n = 0;
	const walk = (at: string): void => {
		for (const name of readdirSync(at)) {
			const full = path.join(at, name);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.(md|txt)$/.test(name)) continue;
			writeFileSync(path.join(dir, `doc${n++}${path.extname(name)}`), readFileSync(full));
		}
	};
	walk(opts.docs);

	if (n === 0) throw new Error(`no documents found under ${opts.docs}`);
	return dir;
}

function invoke(cmd: string, args: readonly string[], dir: string): void {
	const result = spawnSync(cmd, args, {
		cwd: dir,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, NO_COLOR: "1" },
	});
	if (result.error !== undefined) {
		throw new Error(`${cmd}: ${result.error.message}`);
	}
}

/** Runs `fn` `runs` times and returns each wall time, in milliseconds. */
function time(runs: number, fn: () => void): number[] {
	// One run first, unmeasured: the first pays for compiling the rules and
	// warming the filesystem cache, which is not what this is measuring.
	fn();

	const out: number[] = [];
	for (let i = 0; i < runs; i++) {
		const at = performance.now();
		fn();
		out.push(performance.now() - at);
	}
	return out;
}

function report(label: string, times: readonly number[], bytes: number): void {
	const mid = median(times);
	const best = Math.min(...times);
	console.log(
		`${label.padEnd(10)} ${mid.toFixed(0)} ms median` +
			`  (${best.toFixed(0)} ms best of ${times.length})` +
			`  ${((bytes / 1024 / mid) * 1000).toFixed(0)} KB/s`,
	);
}

function median(times: readonly number[]): number {
	const sorted = [...times].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
		: (sorted[mid] ?? 0);
}

function corpusSize(dir: string): number {
	let total = 0;
	for (const name of readdirSync(dir)) {
		if (!/\.(md|txt)$/.test(name)) continue;
		total += statSync(path.join(dir, name)).size;
	}
	return total;
}

function countDocs(dir: string): number {
	return readdirSync(dir).filter((n) => /\.(md|txt)$/.test(n)).length;
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

function parseOptions(argv: readonly string[]): Options {
	const opts: Options = {
		styles: path.join(TESTDATA, "styles"),
		docs: path.join(TESTDATA, "fixtures"),
		runs: 3,
		reference: !argv.includes("--no-reference"),
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--styles") opts.styles = argv[i + 1] ?? opts.styles;
		else if (argv[i] === "--docs") opts.docs = argv[i + 1] ?? opts.docs;
		else if (argv[i] === "--runs") opts.runs = Number(argv[i + 1] ?? opts.runs);
	}
	return opts;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
