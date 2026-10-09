/**
 * Telling a mistyped command from a document.
 *
 * `vale "some text in a string"` is a documented way to lint prose, so an
 * argument Vale does not recognize cannot simply be rejected: most of them are
 * the document. Only a single bare word that is a near miss for a command
 * qualifies, which leaves every real use of that form alone.
 */

import { fileExists, isDir } from "@vale-ts/core";
import { COMMANDS, visibleCommandNames } from "./command.ts";
import { errorln, stderr } from "./out.ts";
import { bold, code, red } from "./term.ts";

/**
 * How far a word may be from a command and still be taken for a misspelling
 * of it.
 *
 * Two edits catches the transpositions and dropped letters that typing
 * produces -- `ls-confg`, `snyc` -- without reaching so far that an ordinary
 * short sentence looks like a command.
 */
const MAX_COMMAND_DISTANCE = 2;

/** The Levenshtein distance between two words. */
export function levenshtein(a: string, b: string): number {
	const first = [...a];
	const second = [...b];

	let prev = Array.from({ length: second.length + 1 }, (_, i) => i);

	for (let i = 1; i <= first.length; i++) {
		const row = [i];
		for (let j = 1; j <= second.length; j++) {
			const cost = first[i - 1] === second[j - 1] ? 0 : 1;
			row[j] = Math.min(
				(prev[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(prev[j - 1] as number) + cost,
			);
		}
		prev = row;
	}

	return prev[second.length] as number;
}

/** The command `arg` was probably meant to be, or nothing. */
export function didYouMean(arg: string): string | null {
	if (/[ \t\n]/.test(arg) || fileExists(arg) || isDir(arg)) return null;

	let best = "";
	let distance = MAX_COMMAND_DISTANCE + 1;

	for (const [name, cmd] of Object.entries(COMMANDS)) {
		if (cmd.hidden === true) continue;

		// A tie goes to the name that sorts first, so the suggestion does not
		// depend on the order the table was written in.
		const d = levenshtein(arg, name);
		if (d < distance || (d === distance && name < best)) {
			best = name;
			distance = d;
		}
	}

	return distance > MAX_COMMAND_DISTANCE ? null : best;
}

/** Explains a mistyped command and how to recover. */
export function reportUnknownCommand(arg: string, suggestion: string): void {
	stderr(`${red("Error:")} unknown command ${bold(arg)}\n\n`);
	stderr(`Did you mean ${bold(suggestion)}?\n\n`);
	errorln(`Commands: ${visibleCommandNames().join(", ")}`);
	errorln(`Run ${code("vale --help")} for more.`);
}
