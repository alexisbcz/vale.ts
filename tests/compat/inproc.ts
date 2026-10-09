#!/usr/bin/env bun
/**
 * Runs the engine without the command line.
 *
 * The compatibility suite drives the real CLI, which is what a user does. This
 * is the same thing with the CLI taken out: the library is called directly and
 * the `line` output is formatted here. Two reasons it exists.
 *
 * It separates two kinds of failure. A case that fails here *and* through the
 * CLI is an engine difference; one that fails only through the CLI is in the
 * argument handling or the output format. Told apart, each is a short search
 * rather than a long one.
 *
 * And it is fast enough to use while working: no process per case, and the
 * rules compile once per configuration rather than once per invocation.
 *
 * ```
 * bun tests/compat/inproc.ts <args...>    # as `vale <args...>` would
 * ```
 */

import * as path from "node:path";
import { Manager } from "@vale-ts/check";
import type { Alert, File } from "@vale-ts/core";
import {
	LEVEL_TO_INT,
	newFlags,
	readPipeline,
	setWarnSink,
	ValeError,
} from "@vale-ts/core";
import { createLinter, DocumentErrors } from "@vale-ts/lint";

/** What one invocation printed and exited with. */
export interface Outcome {
	out: string;
	code: number;
}

/**
 * Runs the engine as `vale <argv>` would, and returns what it printed.
 *
 * Only the flags the compatibility suite passes are understood, because that
 * is all this is for; the real argument parser lives in `@vale-ts/cli`.
 */
export function run(argv: readonly string[]): Outcome {
	const flags = newFlags();
	const inputs: string[] = [];
	let relative = false;

	for (const arg of argv) {
		if (arg === "--sort") flags.sorted = true;
		else if (arg === "--normalize") flags.normalize = true;
		else if (arg === "--relative") relative = true;
		else if (arg === "--no-global") flags.ignoreGlobal = true;
		else if (arg === "--no-exit") flags.noExit = true;
		else if (arg === "--simple") flags.simple = true;
		else if (arg.startsWith("--output=")) flags.output = arg.slice(9);
		else if (arg.startsWith("--glob=")) flags.glob = arg.slice(7);
		else if (arg.startsWith("--ext=")) flags.inExt = arg.slice(6);
		else if (arg.startsWith("--config=")) flags.path = arg.slice(9);
		else if (arg.startsWith("--minAlertLevel=")) flags.alertLevel = arg.slice(16);
		else if (arg.startsWith("--filter=")) flags.filter = arg.slice(9);
		else if (arg.startsWith("-")) {
			return { out: `unsupported flag for this runner: ${arg}`, code: 2 };
		} else inputs.push(arg);
	}

	// Warnings go into the output, as they do on the command line, because
	// several cases assert on them.
	let warnings = "";
	const previous = setWarnSink((msg) => {
		warnings += `W101 ${msg}\n`;
	});

	try {
		const config = readPipeline(flags, false);
		const linter = createLinter(Manager.create(config));

		let files: File[];
		try {
			files = linter.lint(inputs.length > 0 ? inputs : ["."], flags.glob);
		} catch (err) {
			if (!(err instanceof DocumentErrors)) throw err;
			return {
				out: warnings + err.errors.map(render).join("\n"),
				code: 2,
			};
		}

		// `--sort` orders the *files* by path; the alerts within one are always
		// in document order. Sorting the rendered lines instead would order
		// `1:22` before `1:6`, which is not what Vale prints.
		const ordered = flags.sorted
			? [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
			: files;

		const lines: string[] = [];
		let hasErrors = false;
		for (const file of ordered) {
			const shown = relative ? relativeTo(file.path) : file.path;
			for (const alert of file.sortedAlerts()) {
				if ((LEVEL_TO_INT[alert.severity] ?? 0) < config.minAlertLevel) continue;
				if (alert.severity === "error") hasErrors = true;
				lines.push(format(shown, alert));
			}
		}

		const out = warnings + lines.join("\n");
		return { out, code: hasErrors && !flags.noExit ? 1 : 0 };
	} catch (err) {
		return { out: warnings + render(err), code: 2 };
	} finally {
		setWarnSink(previous);
	}
}

/** One alert, in the `line` format: `path:line:column:check:message`. */
function format(file: string, a: Alert): string {
	return `${file}:${a.line}:${a.span[0]}:${a.check}:${a.message}`;
}

function relativeTo(p: string): string {
	const rel = path.relative(process.cwd(), p);
	return rel.startsWith("..") ? p : rel;
}

function render(err: unknown): string {
	if (err instanceof ValeError) {
		return err.code === "E100"
			? `E100 [${err.context}] ${err.msg}`
			: `E201 ${err.path}:${err.line}:${err.span} ${err.msg}`;
	}
	return err instanceof Error ? err.message : String(err);
}

if (import.meta.main) {
	const outcome = run(process.argv.slice(2));
	if (outcome.out !== "") console.log(outcome.out);
	process.exit(outcome.code);
}
