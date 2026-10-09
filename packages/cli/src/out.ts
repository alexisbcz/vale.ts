/**
 * Where the CLI's output goes.
 *
 * Go writes to `os.Stdout` and `os.Stderr` from a dozen places. Here the two
 * streams are a pair of functions so that `run(argv)` can be called in-process
 * -- which is how the compatibility suite checks an exit code without paying
 * for a subprocess -- and so that a test can read what a command printed
 * instead of reaching for a pipe.
 *
 * Writes are unbuffered and in order within a stream, the same as Go's.
 */

/** A sink for one stream. */
export type Writer = (text: string) => void;

const toStdout: Writer = (text) => {
	process.stdout.write(text);
};

const toStderr: Writer = (text) => {
	process.stderr.write(text);
};

let outWriter: Writer = toStdout;
let errWriter: Writer = toStderr;

/** Writes to stdout. */
export function stdout(text: string): void {
	outWriter(text);
}

/** Writes to stdout, with a trailing newline. */
export function println(text = ""): void {
	outWriter(`${text}\n`);
}

/** Writes to stderr. */
export function stderr(text: string): void {
	errWriter(text);
}

/** Writes to stderr, with a trailing newline. */
export function errorln(text = ""): void {
	errWriter(`${text}\n`);
}

/** What one captured run printed. */
export interface Captured {
	out: string;
	err: string;
	/** Both streams in the order they were written, as a terminal shows them. */
	combined: string;
}

/**
 * Collects everything written during `body` rather than printing it.
 *
 * The streams are restored even when `body` throws, so one failing case cannot
 * silence the rest of a test file.
 */
export async function capture(
	body: () => Promise<void> | void,
): Promise<Captured> {
	const prevOut = outWriter;
	const prevErr = errWriter;

	const out: string[] = [];
	const err: string[] = [];
	const combined: string[] = [];

	outWriter = (text) => {
		out.push(text);
		combined.push(text);
	};
	errWriter = (text) => {
		err.push(text);
		combined.push(text);
	};

	try {
		await body();
	} finally {
		outWriter = prevOut;
		errWriter = prevErr;
	}

	return {
		out: out.join(""),
		err: err.join(""),
		combined: combined.join(""),
	};
}
