/**
 * How a failure of Vale's own is shown, in each output format.
 *
 * The three formats carry different amounts of the error: `CLI` shows the
 * banner, with an excerpt of the file when there is one; `line` shows one line
 * a script can parse; `JSON` shows the fields. Which means the error is kept in
 * parts until here -- see `ValeError` in `@vale-ts/core` -- rather than
 * rendered once and taken apart again.
 */

import { toSlash, ValeError } from "@vale-ts/core";
import type { Writer } from "./out.ts";
import { code, italic, onRed, sgrGreenBold } from "./term.ts";
import { getJSON, messageOf } from "./util.ts";

/**
 * Returns `err` as Vale's own error, or wraps one that is not -- from a
 * library, say -- as an E100.
 */
export function asValeError(err: unknown): ValeError {
	if (err instanceof ValeError) return err;
	return new ValeError({ code: "E100", msg: messageOf(err) });
}

/** A line number in an error's excerpt, colored so `--no-color` reaches it. */
function gutter(n: number): string {
	return sgrGreenBold(String(n).padStart(4, " "));
}

/**
 * The banner a terminal sees:
 *
 * ```
 * <code> <title>
 *
 * <excerpt>
 * <msg>
 *
 * Execution stopped with code 2.
 * ```
 */
export function banner(e: ValeError): string {
	let body = e.msg;

	if (e.excerpt.length > 0) {
		let lines = "";
		for (const l of e.excerpt) {
			lines += `${gutter(l.number)}${l.marked ? "*" : " "} ${l.text}\n`;
		}
		body = `${lines}\n${e.msg}`;
	}

	return (
		`${onRed(e.code)} ${e.title()}\n\n${body}\n\n` +
		code(italic("Execution stopped with code 2."))
	);
}

/**
 * An error as text, which for Vale's own is the banner.
 *
 * Go gets this from `error.Error()`, so anywhere it prints an error -- a test
 * case that could not run, say -- the whole banner lands there.
 */
export function renderError(err: unknown): string {
	return err instanceof ValeError ? banner(err) : messageOf(err);
}

/** Writes `err` in the user-specified format. */
export function showError(err: unknown, style: string, out: Writer): void {
	const ve = asValeError(err);

	switch (style) {
		case "JSON":
			out(
				`${getJSON({
					Line: ve.line,
					Path: toSlash(ve.path),
					Text: ve.msg,
					Code: ve.code,
					Span: ve.span,
				})}\n`,
			);
			return;
		case "line": {
			// One line, as the alerts are: a position when there is one, and
			// otherwise the context stands in for it. A message can span lines
			// -- a parser's own excerpt, say -- so only its first is kept.
			const first = ve.msg.split("\n")[0] ?? "";
			if (ve.path !== "") {
				out(`${toSlash(ve.path)}:${ve.line}:${ve.code}:${first}\n`);
			} else if (ve.context !== "") {
				out(`[${ve.context}]:${ve.code}:${first}\n`);
			} else {
				out(`${ve.code}:${first}\n`);
			}
			return;
		}
		default:
			// A plain error prints its own message; Vale's prints the banner.
			out(`${renderError(err)}\n`);
	}
}
