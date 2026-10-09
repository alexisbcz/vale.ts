/**
 * The small amount of terminal rendering Vale needs, written out rather than
 * taken from a library.
 *
 * Go reaches for `pterm` and `tablewriter`. What it actually uses of them is
 * eight colors, four prefixed message styles and two table shapes, so they are
 * here instead: the output is what those libraries produce for these inputs,
 * and nothing is pulled in to reproduce it.
 *
 * Every style is a no-op when color is off, which is what makes the end-to-end
 * output comparable; see `tty.ts` for when that is.
 */

import { stripANSI, strLen } from "@vale-ts/core";
import { println, stdout } from "./out.ts";
import { colorOn, progressOn } from "./tty.ts";

/** Wraps `text` in an SGR sequence, or returns it unchanged. */
function sgr(codes: string, text: string): string {
	if (!colorOn() || text === "") return text;
	return `\u001b[${codes}m${text}\u001b[0m`;
}

export const red = (s: string): string => sgr("31", s);
export const green = (s: string): string => sgr("32", s);
export const yellow = (s: string): string => sgr("33", s);
export const blue = (s: string): string => sgr("34", s);
export const gray = (s: string): string => sgr("90", s);
export const bold = (s: string): string => sgr("1", s);
export const italic = (s: string): string => sgr("3", s);
export const underline = (s: string): string => sgr("4", s);
export const onRed = (s: string): string => sgr("41", s);

/** Green and bold, which is how an error's excerpt numbers its lines. */
export const sgrGreenBold = (s: string): string => sgr("32;1", s);

/**
 * `pterm.Fuzzy`, which Vale uses for anything the reader would type back --
 * a flag, a command, a path.
 */
export const code = (s: string): string => sgr("90", s);

/** The printable width of a cell, ignoring the styling in it. */
export function width(cell: string): number {
	return strLen(stripANSI(cell));
}

/** Pads `cell` out to `n` printable columns. */
function pad(cell: string, n: number): string {
	return cell + " ".repeat(Math.max(0, n - width(cell)));
}

/** The widest cell in each column. */
function columnWidths(rows: readonly string[][]): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		for (let i = 0; i < row.length; i++) {
			widths[i] = Math.max(widths[i] ?? 0, width(row[i] ?? ""));
		}
	}
	return widths;
}

/**
 * The borderless table Vale shows alerts and help listings in.
 *
 * `tablewriter` with no borders, no separators and no line symbols still pads
 * each cell with a space on either side, so a row reads as
 * `' cell  cell  cell '` -- one leading space, two between columns, and one
 * trailing. The trailing space is not trimmed, and Vale's own expected output
 * carries it.
 *
 * Nothing wraps: `tablewriter` only wraps to a width it can measure, and a
 * redirected stdout has none. `--no-wrap` therefore changes nothing here, the
 * same as in Go.
 */
export function renderBorderless(rows: readonly string[][]): string {
	if (rows.length === 0) return "";

	const widths = columnWidths(rows);
	const lines: string[] = [];

	for (const row of rows) {
		let line = "";
		for (let i = 0; i < widths.length; i++) {
			line += ` ${pad(row[i] ?? "", widths[i] ?? 0)} `;
		}
		lines.push(line);
	}

	return `${lines.join("\n")}\n`;
}

/**
 * `pterm.DefaultTable`, which `ls-dirs` and `ls-vars` print.
 *
 * Columns are padded to their widest cell and joined with ` | `; the header is
 * just the first row, with no rule under it.
 */
export function renderTable(rows: readonly string[][]): string {
	if (rows.length === 0) return "";

	const widths = columnWidths(rows);
	const lines: string[] = [];

	for (const row of rows) {
		const cells: string[] = [];
		for (let i = 0; i < widths.length; i++) {
			cells.push(pad(row[i] ?? "", widths[i] ?? 0));
		}
		lines.push(cells.join(" | "));
	}

	return `${lines.join("\n")}\n`;
}

/**
 * One of pterm's prefixed messages.
 *
 * The prefix is the label with a space either side, then a second space before
 * the message. pterm's own labels are not padded to a common width -- `ERROR`
 * carries its own spaces so that it lines up with `SUCCESS` and `WARNING`,
 * while `INFO` does not -- so they are spelled here as pterm spells them.
 */
function prefixed(label: string, style: string, message: string): string {
	return `${sgr(style, ` ${label} `)} ${message}`;
}

export const successMessage = (msg: string): string =>
	prefixed("SUCCESS", "30;102", msg);
export const errorMessage = (msg: string): string =>
	prefixed(" ERROR ", "30;101", msg);
export const warningMessage = (msg: string): string =>
	prefixed("WARNING", "30;103", msg);
export const infoMessage = (msg: string): string =>
	prefixed("INFO", "30;106", msg);

export function printSuccess(msg: string): void {
	println(successMessage(msg));
}

export function printError(msg: string): void {
	println(errorMessage(msg));
}

export function printWarning(msg: string): void {
	println(warningMessage(msg));
}

export function printInfo(msg: string): void {
	println(infoMessage(msg));
}

/** A bar redrawn in place while `sync` works through its packages. */
export interface Progress {
	update(title: string): void;
	increment(): void;
	stop(): void;
}

const BAR_WIDTH = 40;

/**
 * A progress bar, or nothing when nobody is watching.
 *
 * pterm draws its bar whatever stdout is, which leaves a CI log full of
 * carriage-returned frames; here a redirected run prints nothing and
 * `--plain-progress` is the way to get a record of what was installed.
 */
export function newProgress(total: number): Progress | null {
	if (!progressOn()) return null;

	let done = 0;
	let title = "";

	const draw = () => {
		const share = total === 0 ? 1 : done / total;
		const filled = Math.round(share * BAR_WIDTH);
		const bar = "█".repeat(filled) + " ".repeat(BAR_WIDTH - filled);
		stdout(
			`\r${title} [${done}/${total}] ${bar} ${Math.round(share * 100)}%`,
		);
	};

	draw();

	return {
		update(next: string): void {
			title = next;
			draw();
		},
		increment(): void {
			done++;
			draw();
		},
		stop(): void {
			stdout("\n");
		},
	};
}

/** The mark `ls-dirs` and `ls-vars` show for something that is there. */
export const foundMark = (): string => green("✓");
/** The mark for something that is not. */
export const missingMark = (): string => red("✗");
