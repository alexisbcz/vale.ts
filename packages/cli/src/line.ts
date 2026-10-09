/**
 * `--output=line`: one alert per line, as `path:line:col:check:message`.
 *
 * This is the format Vale's own end-to-end suite asserts on, so it is
 * byte-for-byte.
 */

import * as path from "node:path";
import type { File } from "@vale-ts/core";
import { println } from "./out.ts";

/**
 * The directory the binary was run from, which `--relative` measures against.
 *
 * Go reads `os.Args[0]`; the nearest thing here is the script Bun was handed.
 * Upstream's own comment says this does not work as intended and is kept only
 * because its tests depend on the output, so the branch below is as dead here
 * as it is there.
 */
function exeDir(): string {
	const arg0 = process.argv[1] ?? process.execPath;
	return path.resolve(path.dirname(arg0));
}

/** Prints the alerts, and reports whether any of them was an error. */
export function printLineAlerts(
	linted: readonly File[],
	relative: boolean,
): boolean {
	const dir = exeDir();
	let errors = 0;

	for (const f of linted) {
		// Run from a parent directory of the file, a shorter path is shown --
		// `testdata/test.cc: ...` rather than the whole of it.
		const base =
			relative && f.path.includes(dir) ? (f.path.split(dir)[1] ?? f.path) : f.path;

		for (const a of f.sortedAlerts()) {
			if (a.severity === "error") errors++;
			println(`${base}:${a.line}:${a.span[0]}:${a.check}:${a.message}`);
		}
	}

	return errors !== 0;
}
