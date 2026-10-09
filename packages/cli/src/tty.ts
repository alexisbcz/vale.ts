/**
 * Terminal detection, and the one switch every styled string asks about.
 *
 * Color is for a person looking at a terminal. Redirected to a file or piped
 * into another program it is noise the reader has to strip -- which Vale's own
 * end-to-end suite was doing before it could compare anything. The decision is
 * made once, before the flags are parsed, so that a usage message printed
 * during parsing is already plain, and revisited once `--no-color` is known.
 *
 * Go reaches for `go-isatty` and lets pterm read `NO_COLOR`; both are a line
 * each here.
 */

let colorEnabled = false;
let progressEnabled = false;

/** Whether a stream is an interactive terminal. */
export function isTTY(stream: { isTTY?: boolean }): boolean {
	return stream.isTTY === true;
}

/**
 * Sets the defaults from the environment.
 *
 * Called before the flags are parsed. `NO_COLOR` is honored however it is set,
 * including to the empty string, which is what the convention asks for.
 */
export function detectTerminal(): void {
	const tty = isTTY(process.stdout);
	colorEnabled = tty && process.env.NO_COLOR === undefined;
	progressEnabled = tty;
}

/** Applies `--no-color`, once the flags are known. */
export function configureColor(noColor: boolean): void {
	if (noColor) colorEnabled = false;
}

/** Whether styled output is wanted. */
export function colorOn(): boolean {
	return colorEnabled;
}

/**
 * Whether a progress bar is wanted.
 *
 * A bar redrawn into a CI log leaves a trail of frames and, at the end, no
 * record of what was installed, so nothing is drawn unless someone is watching.
 * `--plain-progress` asks for the line-per-step form instead.
 */
export function progressOn(): boolean {
	return progressEnabled;
}

/** Forces the two switches, for a test that wants one or the other. */
export function setTerminal(color: boolean, progress: boolean): void {
	colorEnabled = color;
	progressEnabled = progress;
}

detectTerminal();
