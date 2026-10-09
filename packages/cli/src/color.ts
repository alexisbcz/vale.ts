/**
 * `--output=CLI`: the human-readable report, a table per file and one summary.
 *
 * The layout is `tablewriter`'s borderless rendition, which `term.ts`
 * reproduces: a leading space, two spaces between columns, and a trailing one.
 * The blank lines around each table are Vale's, and its expected output carries
 * them.
 */

import type { File } from "@vale-ts/core";
import { println, stdout } from "./out.ts";
import { blue, red, renderBorderless, underline, yellow } from "./term.ts";
import { pluralize } from "./util.ts";

/** How many alerts of each severity one file held. */
interface Tally {
	errors: number;
	warnings: number;
	suggestions: number;
}

/** Prints every file's alerts and the run's summary. */
export function printVerboseAlerts(linted: readonly File[]): boolean {
	const total: Tally = { errors: 0, warnings: 0, suggestions: 0 };

	for (const f of linted) {
		const one = printFileAlerts(f);
		total.errors += one.errors;
		total.warnings += one.warnings;
		total.suggestions += one.suggestions;
	}

	const etotal = `${total.errors} ${pluralize("error", total.errors)}`;
	const wtotal = `${total.warnings} ${pluralize("warning", total.warnings)}`;
	const stotal = `${total.suggestions} ${pluralize(
		"suggestion",
		total.suggestions,
	)}`;

	const symbol =
		total.errors > 0 || total.warnings > 0 ? "✖" : "✔";

	const n = linted.length;
	const where =
		n === 1 && (linted[0]?.path ?? "").startsWith("stdin")
			? "stdin"
			: `${n} ${pluralize("file", n)}`;

	println(
		`${symbol} ${red(etotal)}, ${yellow(wtotal)} and ${blue(stotal)} in ${where}.`,
	);

	return total.errors !== 0;
}

/** One file's table: line, column, level, message and rule. */
function printFileAlerts(f: File): Tally {
	const tally: Tally = { errors: 0, warnings: 0, suggestions: 0 };

	const alerts = f.sortedAlerts();
	if (alerts.length === 0) return tally;

	const rows: string[][] = [];
	for (const a of alerts) {
		let level = a.severity;
		switch (a.severity) {
			case "suggestion":
				level = blue(a.severity);
				tally.suggestions++;
				break;
			case "warning":
				level = yellow(a.severity);
				tally.warnings++;
				break;
			case "error":
				level = red(a.severity);
				tally.errors++;
				break;
		}
		rows.push([`${a.line}:${a.span[0]}`, level, a.message, a.check]);
	}

	stdout(`\n ${underline(f.path)}`);
	println();
	stdout(renderBorderless(rows));
	println();

	return tally;
}
