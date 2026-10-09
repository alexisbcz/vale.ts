/**
 * `vale test`: running a configuration's own test cases.
 *
 * A failing case means Vale worked and the configuration did not, so the run
 * exits 1 rather than reporting a failure of Vale's own -- which is the same
 * distinction `vale file.md` draws between exiting 1 and exiting 2. A case that
 * could not run at all is the other way round: the configuration is broken, so
 * that exits 2, but only after the rest have reported.
 */

import { newE100, relToWD, type CLIFlags } from "@vale-ts/core";
import { println, stdout } from "./out.ts";
import { installPackages } from "./sync.ts";
import { Add, Del, diff, type Line, Same } from "./testsuite/diff.ts";
import { ruleNames, uncovered } from "./testsuite/coverage.ts";
import { failed, Runner, type Result } from "./testsuite/run.ts";
import { findCases, loadCases } from "./testsuite/suite.ts";
import {
	bold,
	gray,
	green,
	printError,
	printSuccess,
	red,
} from "./term.ts";
import { pluralize, printJSON } from "./util.ts";

/**
 * Reports cases that ran and did not pass.
 *
 * Not an error in the sense the others are -- Vale worked, the configuration
 * did not -- so `main` exits 1 with it rather than printing it as a failure of
 * Vale's own.
 */
export class TestFailed extends Error {
	constructor() {
		super("test cases failed");
		this.name = "TestFailed";
	}
}

/** One case, as the JSON report carries it. */
interface TestResult {
	file: string;
	name: string;
	passed: boolean;
	reason?: string;
	/** Why the case could not run at all. */
	error?: string;
	got?: string;
	want?: string;
}

/** Runs the test cases in the given files or directories. */
export async function runTests(
	args: readonly string[],
	flags: CLIFlags,
): Promise<void> {
	let paths: string[];
	try {
		paths = findCases(args);
	} catch (err) {
		throw newE100("test", err);
	}
	if (paths.length === 0) {
		throw newE100("test", new Error("no test files found"));
	}

	const runner = new Runner(flags);
	runner.install = installPackages;

	try {
		// `findCases` casts a wide net -- any YAML file might be a rule with
		// in-source cases -- so the files worth reporting are the ones that held
		// cases, not the ones considered.
		let files = 0;
		const results: Result[] = [];

		for (const file of paths) {
			let cases: ReturnType<typeof loadCases>;
			try {
				cases = loadCases(file);
			} catch (err) {
				throw newE100("test", err);
			}
			if (cases.length > 0) files++;
			for (const c of cases) results.push(await runner.run(c));
		}

		if (results.length === 0) {
			throw newE100("test", new Error("no test cases found"));
		}

		let missing: string[] = [];
		if (flags.coverage) {
			try {
				missing = uncovered(ruleNames(args, runner.searchPaths()), results);
			} catch (err) {
				throw newE100("test", err);
			}
		}

		let failure: Error | null = null;
		try {
			if (flags.output === "JSON") reportTestsJSON(results, missing);
			else reportTests(results, files, missing);
		} catch (err) {
			if (err instanceof TestFailed) failure = err;
			else throw err;
		}

		const broken = results.filter((r) => r.err !== null).length;
		if (broken > 0) {
			throw newE100(
				"test",
				new Error(
					`${broken} ${pluralize("case", broken)} could not run`,
				),
			);
		}
		if (failure !== null) throw failure;
	} finally {
		runner.close();
	}
}

/** The human-readable report. */
function reportTests(
	results: readonly Result[],
	files: number,
	missing: readonly string[],
): void {
	let failures = 0;

	for (const r of results) {
		if (!failed(r)) continue;
		failures++;

		const reason = r.err !== null ? "could not run" : r.reason;
		println(`\n${red("✗")} ${bold(r.case.name)} ${gray(`— ${reason}`)}\n`);

		if (r.case.about !== "") {
			println(`  ${gray("about")} ${r.case.about}`);
		}
		println(`  ${gray("from")}  ${relPath(r.case.path)}\n`);

		if (r.err !== null) {
			stdout(indentBlock(r.err.message));
		} else if (r.case.want !== null) {
			stdout(renderDiff(diff(r.case.want, r.got)));
		} else {
			stdout(indentBlock(blockOrNone(r.got)));
		}
	}

	if (missing.length > 0) {
		println(
			`\n${red("✗")} ${bold(
				`${missing.length} ${pluralize("rule", missing.length)} produced no alert in any case`,
			)}\n`,
		);
		for (const rule of missing) println(`    ${rule}`);
	}

	let summary = `${files} ${pluralize("file", files)} — ${
		results.length - failures
	} passed, ${failures} failed`;
	if (missing.length > 0) summary += `, ${missing.length} uncovered`;

	if (failures > 0 || missing.length > 0) {
		println();
		printError(summary);
		throw new TestFailed();
	}

	printSuccess(summary);
}

/** The machine-readable report. */
function reportTestsJSON(
	results: readonly Result[],
	missing: readonly string[],
): void {
	let passed = 0;
	let failures = 0;
	const out: TestResult[] = [];

	for (const r of results) {
		if (failed(r)) failures++;
		else passed++;

		const entry: TestResult = {
			file: r.case.path,
			name: r.case.name,
			passed: !failed(r),
		};
		// `omitempty`: an empty field is left out rather than carried as "".
		if (r.reason !== "") entry.reason = r.reason;
		if (r.got !== "") entry.got = r.got;
		if (r.case.want !== null && r.case.want !== "") entry.want = r.case.want;
		if (r.err !== null) entry.error = r.err.message;

		out.push(entry);
	}

	const report: Record<string, unknown> = {
		passed,
		failed: failures,
		results: out,
	};
	if (missing.length > 0) report.uncovered = missing;

	printJSON(report);

	if (failures > 0 || missing.length > 0) throw new TestFailed();
}

/** Colors a diff and indents it under its heading. */
function renderDiff(lines: readonly Line[]): string {
	if (lines.length === 0) return indentBlock("(no alerts)");

	let out = "";
	for (const line of lines) {
		let text = `${line.op} ${line.text}`;
		switch (line.op) {
			case Del:
				text = red(text);
				break;
			case Add:
				text = green(text);
				break;
			case Same:
				text = gray(text);
				break;
		}
		out += `    ${text}\n`;
	}

	out += `\n    ${red("- expected")}   ${green("+ actual")}\n`;
	return out;
}

/**
 * Shortens a path against the working directory, since that is where the reader
 * is standing.
 */
function relPath(p: string): string {
	return relToWD(p);
}

/** Indents a rendered block so it sits under its heading. */
function indentBlock(s: string): string {
	let out = "";
	for (const line of s.replace(/\n+$/, "").split("\n")) {
		out += `    ${line}\n`;
	}
	return out;
}

function blockOrNone(s: string): string {
	return s.trim() === "" ? "(no alerts)" : s;
}
