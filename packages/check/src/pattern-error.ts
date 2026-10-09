/**
 * Reporting a rule whose pattern did not compile.
 *
 * Vale wraps a rule's tokens in a larger pattern before compiling it, and the
 * engine's message quotes that whole pattern -- `(?m)\b(?:(unclosed)\b` for a
 * token written `(unclosed`. So each of the rule's own patterns is compiled
 * alone, and the error points at the first that fails, with the engine's
 * message about it. When none fails alone, the fault is in how they combine,
 * and the original error is reported as it was.
 */

import { newE201FromPosition, newE201FromTarget, ValeError } from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";

const LEADING_FLAGS = /^\(\?[a-zA-Z-]+\)/;

/** Where an unparsable pattern among `patterns` should be reported. */
export function patternError(
	err: unknown,
	path: string,
	...patterns: readonly string[]
): ValeError {
	for (const p of patterns) {
		if (p.trim() === "") continue;
		let failure: unknown = null;
		try {
			Regexp.compile(p);
		} catch (pErr) {
			failure = pErr;
		}
		if (failure === null) continue;

		// A flag group Vale added, `(?-i)` on an exception, is not in the
		// file, so the pattern is found and shown without it.
		const written = p.replace(LEADING_FLAGS, "");
		const detail = messageOf(failure).replace(/^error parsing regexp: /, "");
		const msg = `Invalid pattern: ${detail}`.replace(`\`${p}\``, `\`${written}\``);

		const placed = newE201FromTarget(msg, written, path);
		if (placed instanceof ValeError && placed.line === 0) {
			// Written differently in the file -- escaped, or quoted -- so the
			// line cannot be found by its text.
			return newE201FromPosition(`${msg} (in '${written}')`, path, 1);
		}
		return placed;
	}
	return newE201FromPosition(messageOf(err), path, 1);
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
