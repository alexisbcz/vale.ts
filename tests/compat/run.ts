#!/usr/bin/env bun
/**
 * The compatibility suite.
 *
 * Every case Vale declares for itself is run against this port and compared to
 * the output Vale recorded. With `--reference`, the pinned Go binary is run on
 * the same inputs too, which answers a different question: not "does this port
 * match what was recorded" but "do the two implementations agree *here, now*".
 * The second is the one that matters when a case is skipped upstream, or when a
 * converter on this machine behaves differently from the one that produced the
 * recording.
 *
 * ```
 * bun tests/compat/run.ts                       # this port against the corpus
 * bun tests/compat/run.ts --reference           # and against the real binary
 * bun tests/compat/run.ts --only checks/script  # one case
 * bun tests/compat/run.ts --report compat.md    # write a report
 * ```
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fetchCorpus, fetchReference, REFERENCE, TESTDATA } from "./fetch.ts";
import { SHARED_FLAGS } from "./pinned.ts";
import {
	type Case,
	clean,
	isInline,
	loadSuites,
	missingTools,
	type Suite,
	workdir,
} from "./suite.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(HERE, "..", "..", "packages", "cli", "src", "main.ts");
const INPROC = path.join(HERE, "inproc.ts");

/** What one case came to. */
export interface Outcome {
	suite: string;
	case: string;
	about: string;
	status: "pass" | "fail" | "skip";
	/** Why it was skipped, or how it failed. */
	note: string;
	/** What this port printed. */
	got: string;
	gotExit: number;
	/** What the corpus says Vale prints. */
	want: string | null;
	wantExit: number;
	/** What the reference binary printed, when it was run. */
	reference?: string;
	referenceExit?: number;
	/** Whether the two implementations agreed, when both ran. */
	agrees?: boolean;
}

export interface Options {
	/** Also run the pinned reference binary. */
	reference: boolean;
	/** Run only the cases whose `<suite>/<case>` path starts with this. */
	only: string;
	/** Treat a missing converter as a failure rather than a skip. */
	strict: boolean;
	/** Where to write a Markdown report. */
	report: string;
	/** Print each case as it runs. */
	verbose: boolean;
	/**
	 * Call the engine directly instead of the command line.
	 *
	 * A case that fails both ways is an engine difference; one that fails only
	 * through the CLI is in the argument handling or the output format.
	 */
	inproc: boolean;
	/**
	 * Run the reference binary *as* the implementation under test.
	 *
	 * This checks the harness rather than the port: if the pinned binary does
	 * not reproduce its own recorded output here, the difference is in the
	 * harness, the corpus, or this machine's converters -- not in the port.
	 */
	selfCheck: boolean;
}

export async function main(argv: readonly string[]): Promise<number> {
	const opts = parseOptions(argv);

	fetchCorpus();
	if (opts.reference || opts.selfCheck) await fetchReference();

	const suites = loadSuites(path.join(TESTDATA, "e2e"));
	const outcomes: Outcome[] = [];

	for (const suite of suites) {
		for (const kase of suite.cases) {
			const full = `${suite.name}/${kase.name}`;
			if (opts.only !== "" && !full.startsWith(opts.only)) continue;
			const outcome = runCase(suite, kase, opts);
			outcomes.push(outcome);
			if (opts.verbose || outcome.status === "fail") report(outcome);
		}
	}

	summarize(outcomes, opts);
	if (opts.report !== "") {
		writeFileSync(opts.report, renderReport(outcomes, opts));
		console.log(`\nreport: ${opts.report}`);
	}

	return outcomes.some((o) => o.status === "fail") ? 1 : 0;
}

/** Runs one case and reports what came of it. */
export function runCase(suite: Suite, kase: Case, opts: Options): Outcome {
	const base: Outcome = {
		suite: suite.name,
		case: kase.name,
		about: kase.about,
		status: "pass",
		note: "",
		got: "",
		gotExit: 0,
		want: kase.want === null ? null : clean(kase.want),
		wantExit: kase.exit,
	};

	const absent = missingTools(kase.requires);
	if (absent.length > 0 && !opts.strict) {
		return { ...base, status: "skip", note: `needs ${absent.join(", ")}` };
	}

	let dir: string;
	try {
		dir = prepare(suite, kase);
	} catch (err) {
		return {
			...base,
			status: "fail",
			note: `preparing the case: ${message(err)}`,
		};
	}

	if (kase.sync) {
		// `sync` downloads packages, so it needs the network and must run before
		// the case rather than as part of it.
		const synced = invoke(["sync"], dir, kase, opts.selfCheck, opts.inproc);
		if (synced.code !== 0) {
			return {
				...base,
				status: "fail",
				note: `vale-ts sync exited ${synced.code}\n${synced.out}`,
			};
		}
	}

	const ours = invoke(
		[...SHARED_FLAGS, ...kase.args],
		dir,
		kase,
		opts.selfCheck,
		opts.inproc,
	);
	const outcome: Outcome = { ...base, got: ours.out, gotExit: ours.code };

	if (opts.reference) {
		const theirs = invoke([...SHARED_FLAGS, ...kase.args], dir, kase, true);
		outcome.reference = theirs.out;
		outcome.referenceExit = theirs.code;
		outcome.agrees = theirs.out === ours.out && theirs.code === ours.code;
	}

	const problems = compare(kase, ours.out, ours.code);
	if (problems.length > 0) {
		outcome.status = "fail";
		outcome.note = problems.join("; ");
	}

	return outcome;
}

/** What a case asserts, and which of those assertions failed. */
function compare(kase: Case, got: string, code: number): string[] {
	const problems: string[] = [];

	if (kase.contains !== "") {
		if (!got.includes(clean(kase.contains))) {
			problems.push("expected output is missing");
		}
	} else if (kase.want !== null) {
		if (got !== clean(kase.want)) problems.push("output does not match");
	}

	for (const text of kase.absent) {
		if (got.includes(text)) problems.push(`output should not contain "${text}"`);
	}

	if (code !== kase.exit) {
		problems.push(`exit status is ${code}, expected ${kase.exit}`);
	}

	return problems;
}

/** The directory a case runs in, built from its own files when it has any. */
function prepare(suite: Suite, kase: Case): string {
	const dir = workdir(TESTDATA, suite, kase);
	if (!isInline(suite, kase)) return dir;

	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });

	for (const set of [suite.files, kase.files]) {
		for (const [name, body] of Object.entries(set)) {
			const full = path.join(dir, name);
			mkdirSync(path.dirname(full), { recursive: true });
			writeFileSync(full, body);
		}
	}

	return dir;
}

/**
 * Runs one implementation and returns its combined output.
 *
 * Vale writes alerts to stdout and errors to stderr, and cases assert against
 * both, so the two are concatenated the way `CombinedOutput` does.
 */
function invoke(
	args: readonly string[],
	dir: string,
	kase: Case,
	reference: boolean,
	inproc = false,
): { out: string; code: number } {
	const cmd = reference ? REFERENCE : "bun";
	const entry = inproc ? INPROC : CLI;
	const argv = reference ? [...args] : [entry, ...args];

	const result = spawnSync(cmd, argv, {
		cwd: dir,
		encoding: "utf8",
		stdio: [kase.stdin === "" ? "ignore" : "pipe", "pipe", "pipe"],
		input: kase.stdin === "" ? undefined : readStdin(dir, kase.stdin),
		env: { ...process.env, NO_COLOR: "1" },
		maxBuffer: 64 * 1024 * 1024,
	});

	if (result.error !== undefined) {
		return { out: `could not run ${cmd}: ${result.error.message}`, code: -1 };
	}

	return {
		out: clean(`${result.stdout ?? ""}${result.stderr ?? ""}`),
		code: result.status ?? -1,
	};
}

function readStdin(dir: string, name: string): string {
	return readFileSync(path.join(dir, name), "utf8");
}

// --- reporting ------------------------------------------------------------

function report(o: Outcome): void {
	const label = `${o.suite}/${o.case}`;
	if (o.status === "skip") {
		console.log(`  skip  ${label}  (${o.note})`);
		return;
	}
	if (o.status === "pass") {
		console.log(`  pass  ${label}`);
		return;
	}

	console.log(`  FAIL  ${label}  -- ${o.note}`);
	if (o.about !== "") console.log(`        about: ${o.about}`);
	if (o.want !== null) {
		console.log(indent(diff(o.want, o.got), "        "));
	} else {
		console.log(indent(o.got, "        "));
	}
	if (o.reference !== undefined && o.reference !== o.got) {
		console.log("        the reference binary printed:");
		console.log(indent(o.reference, "        | "));
	}
}

function summarize(outcomes: readonly Outcome[], opts: Options): void {
	const pass = outcomes.filter((o) => o.status === "pass").length;
	const fail = outcomes.filter((o) => o.status === "fail").length;
	const skip = outcomes.filter((o) => o.status === "skip").length;
	const ran = pass + fail;

	console.log("");
	const subject = opts.selfCheck ? "the reference binary" : "this port";
	console.log(
		`${pass}/${ran} cases: ${subject} matches the corpus` +
			`${ran === 0 ? "" : ` (${percent(pass, ran)})`}` +
			`${skip > 0 ? `, ${skip} skipped` : ""}` +
			`${fail > 0 ? `, ${fail} failed` : ""}`,
	);

	if (opts.reference) {
		const compared = outcomes.filter((o) => o.agrees !== undefined);
		const agreed = compared.filter((o) => o.agrees === true).length;
		console.log(
			`${agreed}/${compared.length} agree with the reference binary` +
				`${compared.length === 0 ? "" : ` (${percent(agreed, compared.length)})`}`,
		);
	}
}

function renderReport(outcomes: readonly Outcome[], opts: Options): string {
	const pass = outcomes.filter((o) => o.status === "pass").length;
	const fail = outcomes.filter((o) => o.status === "fail");
	const skip = outcomes.filter((o) => o.status === "skip");
	const ran = pass + fail.length;

	let out = "# Compatibility with Vale\n\n";
	out += `Vale declares its own behavior as end-to-end cases, and this is what\n`;
	out += `happens when they are run against this port.\n\n`;
	out += `| | |\n|---|---|\n`;
	out += `| Cases matching the corpus | ${pass} of ${ran} (${percent(pass, ran)}) |\n`;
	out += `| Skipped (converter absent) | ${skip.length} |\n`;

	if (opts.reference) {
		const compared = outcomes.filter((o) => o.agrees !== undefined);
		const agreed = compared.filter((o) => o.agrees === true).length;
		out += `| Agreeing with the reference binary | ${agreed} of ${compared.length} (${percent(agreed, compared.length)}) |\n`;
	}
	out += "\n";

	if (fail.length > 0) {
		out += "## Cases that do not match\n\n";
		for (const o of fail) {
			out += `### \`${o.suite}/${o.case}\`\n\n`;
			if (o.about !== "") out += `${o.about}\n\n`;
			out += `${o.note}\n\n`;
			if (o.want !== null) {
				out += "```diff\n";
				out += `${diff(o.want, o.got)}\n`;
				out += "```\n\n";
			} else {
				out += "```\n";
				out += `${o.got}\n`;
				out += "```\n\n";
			}
		}
	}

	if (skip.length > 0) {
		out += "## Skipped\n\n";
		for (const o of skip) {
			out += `- \`${o.suite}/${o.case}\` -- ${o.note}\n`;
		}
		out += "\n";
	}

	return out;
}

/** A line-by-line diff, in the shape a `diff` code block renders. */
function diff(want: string, got: string): string {
	const a = want === "" ? [] : want.split("\n");
	const b = got === "" ? [] : got.split("\n");

	const lines: string[] = [];
	const seen = new Set(a);
	const has = new Set(b);

	for (const line of a) {
		if (!has.has(line)) lines.push(`-${line}`);
	}
	for (const line of b) {
		if (!seen.has(line)) lines.push(`+${line}`);
	}
	if (lines.length === 0) {
		// The same lines in a different order.
		lines.push(`-${a.join("\n-")}`, `+${b.join("\n+")}`);
	}
	return lines.join("\n");
}

function indent(s: string, prefix: string): string {
	return s
		.split("\n")
		.map((l) => prefix + l)
		.join("\n");
}

function percent(n: number, of: number): string {
	if (of === 0) return "n/a";
	return `${((n / of) * 100).toFixed(1)}%`;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function parseOptions(argv: readonly string[]): Options {
	const opts: Options = {
		reference: argv.includes("--reference"),
		only: "",
		strict: process.env.VALE_COMPAT_STRICT !== undefined,
		report: "",
		verbose: argv.includes("--verbose") || argv.includes("-v"),
		inproc: argv.includes("--inproc"),
		selfCheck: argv.includes("--self-check"),
	};

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--only") opts.only = argv[i + 1] ?? "";
		else if (argv[i]?.startsWith("--only=")) opts.only = argv[i]!.slice(7);
		else if (argv[i] === "--report") opts.report = argv[i + 1] ?? "";
		else if (argv[i]?.startsWith("--report=")) opts.report = argv[i]!.slice(9);
		else if (argv[i] === "--strict") opts.strict = true;
	}

	return opts;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
