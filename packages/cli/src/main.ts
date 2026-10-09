#!/usr/bin/env bun
/**
 * `vale`: argument handling, the three input cases, and the exit codes.
 *
 * # Exit codes
 *
 * - `0` -- a clean run, or a command that did what it was asked.
 * - `1` -- alerts were found, unless `--no-exit`. `vale test` exits 1 for a
 *   failing case, which is Vale working and the configuration not.
 * - `2` -- a failure of Vale's own, or a document that could not be read.
 *
 * # The three inputs
 *
 * `vale "some text"`, `vale file dir file`, and `cat file | vale`. The first
 * and the third are both "lint a string"; what separates them is whether the
 * single argument looks like a path that does not exist.
 */

import type { Config } from "@vale-ts/core";
import { fileExists, isDir, newE100, readPipeline, ValeError } from "@vale-ts/core";
import { Manager } from "@vale-ts/check";
import { createLinter, DocumentErrors, type Linter } from "@vale-ts/lint";
import { initCode } from "./code.ts";
import type { File } from "@vale-ts/core";
import { COMMANDS } from "./command.ts";
import { printAlerts } from "./common.ts";
import { showError } from "./error.ts";
import { FlagError, parseFlags } from "./flags.ts";
import { countAlerts, printJSONAlertsWithCounts } from "./json.ts";
import { printCommandUsage, printIntro, printUsage } from "./info.ts";
import { errorln, println, stderr, stdout } from "./out.ts";
import { startProfiling } from "./profile.ts";
import { didYouMean, reportUnknownCommand } from "./suggest.ts";
import { TestFailed } from "./test.ts";
import { configureColor, detectTerminal, isTTY } from "./tty.ts";
import { version } from "./version.ts";

/** Whether something is being piped in. */
function piped(): boolean {
	return !isTTY(process.stdin);
}

/**
 * Whether a single argument is a string to lint rather than a path.
 *
 * `1` means "a string": it is not a file and not a directory. `0` means a
 * directory and `-1` an existing file.
 */
function looksLikeStdin(s: string): number {
	if (isDir(s)) return 0;
	if (!fileExists(s) && s !== "") return 1;
	return -1;
}

/** Reads everything on stdin. */
async function readStdin(): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Uint8Array);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Lints whichever of the three inputs the arguments describe. */
async function doLint(
	args: readonly string[],
	linter: Linter,
	glob: string,
): Promise<File[]> {
	const first = args[0];

	if (args.length === 1 && first !== undefined && looksLikeStdin(first) === 1) {
		// Case 1: `vale "some text in a string"`.
		return linter.lintString(first);
	}

	if (args.length > 0) {
		// Case 2: `vale file1 dir1 file2`.
		for (const file of args) {
			if (looksLikeStdin(file) === 1) {
				throw newE100(
					"input",
					new Error(`argument '${file}' does not exist`),
				);
			}
		}
		return linter.lint(args, glob);
	}

	// Case 3: `cat file.md | vale`.
	let text: string;
	try {
		text = await readStdin();
	} catch (err) {
		throw newE100("stdin", err);
	}
	try {
		return linter.lintString(text);
	} catch (err) {
		throw newE100("stdin", err);
	}
}

/**
 * Runs the CLI and returns the exit code.
 *
 * Nothing here calls `process.exit`, so the compatibility suite can run a case
 * in-process and read the code back.
 */
export async function run(argv: readonly string[]): Promise<number> {
	// Every exit path below calls this explicitly, as Go's does: the profile
	// must be written whichever way the run ends.
	const stopProfiling = startProfiling();

	detectTerminal();

	let flags: ReturnType<typeof parseFlags>["flags"];
	let args: string[];
	try {
		({ flags, args } = parseFlags(argv));
	} catch (err) {
		if (!(err instanceof FlagError)) throw err;
		errorln(err.message);
		printUsage(stderr);
		stopProfiling();
		return 2;
	}

	configureColor(flags.noColor);

	if (flags.version) {
		println(`vale version ${version()}`);
		stopProfiling();
		return 0;
	}

	if (args.length === 0 && !flags.help && !piped()) {
		printIntro();
		stopProfiling();
		return 0;
	}

	// `vale help`, `vale help <command>`.
	if (args[0] === "help") {
		const named = args[1];
		if (named !== undefined) {
			const cmd = COMMANDS[named];
			if (cmd !== undefined && cmd.hidden !== true) {
				printCommandUsage(stdout, named, cmd);
				stopProfiling();
				return 0;
			}
		}
		printUsage(stdout);
		stopProfiling();
		return 0;
	}

	const name = args[0];
	if (name !== undefined) {
		const cmd = COMMANDS[name];

		// A bare word that is nearly a command is a typo, not a document.
		// Linting it as one reported "0 errors ... in stdin" and exited 0,
		// which reads as a clean run of something that never ran.
		if (cmd === undefined && args.length === 1) {
			const suggestion = didYouMean(name);
			if (suggestion !== null) {
				reportUnknownCommand(name, suggestion);
				stopProfiling();
				return 2;
			}
		}

		if (cmd !== undefined) {
			// `vale sync --help` is a question about sync, not about Vale.
			if (flags.help) {
				printCommandUsage(stdout, name, cmd);
				stopProfiling();
				return 0;
			}

			try {
				await initCode();
				await cmd.run(args.slice(1), flags);
			} catch (err) {
				stopProfiling();

				// Failing test cases mean Vale worked and the configuration did
				// not, which is the same distinction `vale file.md` draws
				// between exiting 1 and exiting 2. The command has already
				// reported them.
				if (err instanceof TestFailed) return 1;

				showError(err, flags.output, stderr);
				return 2;
			}

			stopProfiling();
			return 0;
		}
	}

	// Help asked for without a command is a question about Vale.
	if (flags.help) {
		printUsage(stdout);
		stopProfiling();
		return 0;
	}

	let config: Config;
	let linter: Linter;
	try {
		await initCode();
		config = readPipeline(flags, false);
		linter = createLinter(Manager.create(config));
	} catch (err) {
		stopProfiling();
		showError(err, flags.output, stderr);
		return 2;
	}

	// Documents that could not be linted are reported after the alerts of the
	// rest, and the run exits as an error.
	let linted: File[] = [];
	let docErrs: Error[] = [];
	try {
		linted = await doLint(args, linter, flags.glob);
	} catch (err) {
		if (err instanceof DocumentErrors) {
			docErrs = err.errors;
		} else {
			stopProfiling();
			showError(err, flags.output, stderr);
			return 2;
		}
	}

	const exit = (hasErrors: boolean): number => {
		for (const e of docErrs) showError(e, flags.output, stderr);
		stopProfiling();
		if (docErrs.length > 0) return 2;
		if (hasErrors && !flags.noExit) return 1;
		return 0;
	};

	if (config.flags.counts && config.flags.output === "JSON") {
		return exit(
			printJSONAlertsWithCounts(linted, countAlerts(linter.manager, linted)),
		);
	}

	try {
		return exit(printAlerts(linted, config));
	} catch (err) {
		stopProfiling();
		showError(err, flags.output, stderr);
		return 2;
	}
}

/**
 * The entry point.
 *
 * An error that reaches here is a bug rather than a diagnosis Vale made, so it
 * is reported as one and still exits 2 -- a script must never read a crash as a
 * clean run.
 */
async function main(): Promise<void> {
	let code = 2;
	try {
		code = await run(process.argv.slice(2));
	} catch (err) {
		showError(err instanceof ValeError ? err : newE100("vale", err), "CLI", stderr);
	}
	process.exit(code);
}

if (import.meta.main) await main();
