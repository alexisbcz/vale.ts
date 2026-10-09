/**
 * Markup embedded in a source file's comments.
 *
 * `[formats] go = md` says the comments in a Go file are Markdown. The file is
 * then read as a *fragment*: tree-sitter finds the comments, and each one is
 * linted as that markup rather than as plain lines.
 *
 * The other half of this file is the arithmetic that puts an alert back. An
 * alert is reported against the comment's extracted text, where the
 * delimiters, the decoration and the base indentation are gone; its line and
 * column in the source are that position plus what the extraction removed.
 */

import type { Alert, Config, File } from "@vale-ts/core";
import type { CodeHost } from "./code.ts";
import {
	dropMasked,
	lintComment,
	rstBatch,
	skipsComment,
	updateQueries,
} from "./code.ts";
import type { Comment, Language } from "./code/index.ts";
import { getComments, getLanguageFromExt, stripAt } from "./code/index.ts";
import { findLine, leadingSpaces } from "./util.ts";

/** What a fragment reader needs from the linter. */
export interface FragmentHost extends CodeHost {
	config: Config;
}

/**
 * How far to move an alert to get from a column in the extracted comment back
 * to a column in the source.
 *
 * A dedented comment recorded exactly what it took off each line, so it is
 * asked rather than measured. Measuring the source line only agrees with the
 * dedent when everything removed was whitespace, which is why a language whose
 * decoration is not whitespace -- JSDoc's ` *` -- reported columns that were
 * short by the width of the decoration.
 *
 * The caller adds `comment.offset` separately, and a comment that starts in
 * from the margin has that same indentation counted in what the dedent
 * removed, so it comes back off here. This is what `leadingSpaces` does for
 * the measured path.
 */
export function commentPadding(
	comment: Comment,
	line: number,
	source: string,
	lang: Language,
): number {
	const n = stripAt(comment, line);
	if (n !== null) {
		// `strip` describes the dedent only. The opening delimiter -- `"""`,
		// `/**` -- was removed before that by `delims`, and it is still on the
		// line the alert is measured against, so it is added here. On any line
		// but the first there is no delimiter and this contributes nothing.
		const p = lang.padding(source);
		if (line === 1 && p > 0) {
			// The delimiter line: `padding` counts the marker and the spaces
			// after it, and those spaces are also what the dedent took off, so
			// adding the strip would count them twice.
			return p;
		}
		return p + Math.max(n - comment.offset, 0);
	}

	let padding = lang.padding(source);
	if (source.startsWith(" ")) {
		padding += leadingSpaces(source, comment.offset);
	}
	return padding;
}

/** Moves the alerts from `last` on into the source the comment came from. */
export function adjustAlerts(
	alerts: Alert[],
	last: number,
	comment: Comment,
	lang: Language,
): void {
	for (let i = last; i < alerts.length; i++) {
		const a = alerts[i];
		const line = findLine(comment.source, a.line);
		const padding = commentPadding(comment, a.line, line, lang);

		a.line += comment.line - 1;
		a.span = [
			a.span[0] + comment.offset + padding,
			a.span[1] + comment.offset + padding,
		];
	}
}

/** Reads a source file whose comments hold markup. */
export function lintFragments(host: FragmentHost, f: File): void {
	const lang = getLanguageFromExt(f.realExt);

	const found = updateQueries(f, host.config);
	if (found.length > 0) lang.queries = found;

	const comments = getComments(f.content, lang);

	const wholeFile = f.content;
	const fallback = f.normedExt.replace(/^\./, "");
	const converted = rstBatch(host, f, comments, fallback);

	let last = 0;
	try {
		for (let i = 0; i < comments.length; i++) {
			const comment = comments[i];

			// QDoc reads `/*! ... *\/` only; a `//` line comment or a plain
			// `/* ... *\/` block is code, not documentation.
			if (f.normedExt === ".qdoc" && !comment.source.startsWith("/*!")) {
				continue;
			}

			f.setMetaScope(comment.scope);
			if (skipsComment(host.config, comment.scope)) continue;

			// The file's own mapping, unless the query named a markup of its own.
			const format = comment.format === "" ? fallback : comment.format;
			lintComment(host, f, comment, format, converted.get(i) ?? "");
			dropMasked(f.alerts, last, comment);

			const size = f.alerts.length;
			if (size !== last) adjustAlerts(f.alerts, last, comment, lang);
			last = size;
		}
	} finally {
		// Each comment was linted in the file's place; put the file back, so the
		// `raw` scope that runs next reads the source and not the last comment.
		f.restoreText(wholeFile);
	}

	host.lintSummary(f);
}
