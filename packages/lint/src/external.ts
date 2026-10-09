/**
 * Running an external converter.
 *
 * reStructuredText goes to Docutils, AsciiDoc to Asciidoctor, DITA to the
 * Open Toolkit and Typst to `typst2vast`. Each is a program Vale shells out
 * to, and each is reached through this one place.
 *
 * # No process pool
 *
 * Go keeps a pool of long-lived helper processes (`proc_pool.go`): converting
 * a document costs a few milliseconds either way, but starting Python or Ruby
 * costs fifty to a hundred and sixty, and Vale was paying that once per file.
 * The pool is worth having -- but it needs to read a reply while another
 * document is being written, which is asynchronous, and every reader in this
 * port is synchronous. So a document is converted with one `spawnSync` per
 * call, which is what Go's own fallback path does when a pool cannot be
 * established. Correctness first; a pool is a change to the whole call chain,
 * not to this file.
 */

import { spawnSync } from "node:child_process";

/**
 * Runs `exe` with `text` on its standard input and returns its output.
 *
 * On failure the error carries the program's standard error, which is far
 * more useful than its exit status -- `rst2html` and `asciidoctor` both say
 * exactly what they could not parse.
 */
export function executeWithInput(
	exe: string,
	text: string,
	args: readonly string[] = [],
	env: Readonly<Record<string, string>> = {},
): string {
	const result = spawnSync(exe, [...args], {
		input: text,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		env: Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env,
	});

	if (result.error !== undefined && result.error !== null) throw result.error;
	if (result.status !== 0) {
		throw new Error(result.stderr ?? `${exe} failed`);
	}

	return result.stdout ?? "";
}
