/**
 * Linting the values a view or a front-matter block holds.
 *
 * A value is not a document, so it cannot simply be read in place: the file's
 * text is swapped for the value, the value is linted as whatever markup it is
 * written in, and the alerts are then moved back to where the value sits in the
 * file. Which is why the file's text is restored afterwards -- the `raw` scope
 * runs next, and it has to see the document rather than the last value read.
 */

import type { Alert, Config, File, ScopedValue, ScopedValues } from "@vale-ts/core";
import { formatFromExt, locateInValue, newE100, strLen } from "@vale-ts/core";
import { adjustPos, countNewlines, findLineBySubstring } from "./util.ts";

/** What linting a scoped value needs from the linter. */
export interface ScopedHost {
	config: Config;
	lintLines(f: File): void;
	/** Reads the file as the named markup, or throws if it has no reader. */
	readAs(f: File, format: string): void;
	/** Reads the file as code in the given language, so its comments are prose. */
	readAsCode(f: File, ext: string): void;
}

/** Lints every value a view found, placing each one's alerts in the file. */
export function lintScopedValues(
	host: ScopedHost,
	f: File,
	values: readonly ScopedValues[],
): void {
	const wholeFile = f.content;
	const srcLines = wholeFile.split("\n");
	// The file's comments were placed already; only the values' alerts move.
	let last = f.alerts.length;

	f.scoped = {};
	for (const match of values) {
		for (const sv of match.values) {
			(f.scoped[match.scope] ??= []).push(sv.text);
		}
	}

	try {
		for (const match of values) {
			f.setMetaScope(match.scope);
			const format = match.format ?? "";
			// Once per scope, not per value: the lookup walks the format table.
			const asCode = isCode(format);

			const seen = new Map<string, number>();
			for (const sv of match.values) {
				const v = sv.text;

				let line = "";
				let i = sv.line;
				let padding = sv.column - 1;
				const fromParse = i > 0 && sv.column > 0;

				if (fromParse) {
					line = srcLines[i - 1] ?? "";
				} else {
					const [found, hit] = findLineBySubstring(wholeFile, v, seen);
					if (found < 0) {
						throw newE100(f.path, new Error(`'${v}' not found`));
					}
					i = found;
					line = hit;
					seen.set(line, i);
					padding = line.indexOf(v);
					if (countNewlines(v) > 0) {
						const firstLine = v.split("\n", 1)[0]!;
						padding = line.indexOf(firstLine);
						if (padding < 0) {
							// A block scalar: use the indentation of the matched line.
							i--;
							padding = line.indexOf(line.trim());
						}
					}
				}

				if (line.includes("\\n") && sv.joined !== true) {
					f.setText(v.replaceAll("\n", " "));
				} else {
					f.setText(v);
				}
				if (sv.joined === true) {
					// One element per source line: an alert's line within the value
					// is its offset from the first, and there is no escaped newline
					// to widen its column by.
					line = "";
				}
				f.setNormedExt(format);

				if (v === "") {
					// An empty value has nothing to parse, and parsing it yields no
					// block at all; a rule that requires text needs one to run on.
					host.lintLines(f);
				} else if (
					format === "md" ||
					format === "rst" ||
					format === "html" ||
					format === "org" ||
					format === "adoc"
				) {
					host.readAs(f, format);
				} else if (asCode) {
					host.readAsCode(f, `.${format}`);
				} else {
					host.lintLines(f);
				}

				const size = f.alerts.length;
				if (size === last) continue;
				if (sv.parts !== undefined && sv.parts.length > 0) {
					placeAlerts(f.alerts, last, sv, f.content);
				} else {
					adjustPos(f.alerts, last, i, padding, v, line);
				}
				last = size;
			}
		}
	} finally {
		// The values were linted in the file's place; put the file back.
		f.restoreText(wholeFile);
	}
}

/**
 * Moves the alerts from `last` on, reported against the value's text, to where
 * the value's parts sit in the source.
 */
export function placeAlerts(
	alerts: Alert[],
	last: number,
	sv: ScopedValue,
	text: string,
): void {
	const lines = text.split("\n");
	for (let i = last; i < alerts.length; i++) {
		const a = alerts[i]!;

		// The alert's character offset within the value.
		let off = 0;
		for (let k = 0; k < a.line - 1 && k < lines.length; k++) {
			off += strLen(lines[k]!) + 1;
		}
		off += Math.max(a.span[0]! - 1, 0);

		const [line, col] = locateInValue(sv, off);
		const [endLine, endArg] = locateInValue(
			sv,
			off + Math.max(a.span[1]! - a.span[0]!, 0),
		);
		let end = endArg;
		if (endLine !== line || end < col) end = col + a.span[1]! - a.span[0]!;

		a.line = line;
		a.span = [col, end];
	}
}

/** Whether a scope's `type` names a programming language. */
export function isCode(format: string): boolean {
	const [, kind] = formatFromExt(`x.${format}`, {});
	return kind === "code";
}
