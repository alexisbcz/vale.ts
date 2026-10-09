/**
 * The profiling hook `VALE_CPUPROFILE` and `VALE_MEMPROFILE` ask for.
 *
 * Environment variables rather than flags, as in Go: Vale's flag set is
 * user-facing and stable, while this is a development tool. It also means a
 * profile can be captured from a run driven by an editor or a script without
 * changing the command line.
 *
 * Go writes a `pprof` profile. Bun's profiler is the V8 one and is driven from
 * outside the process (`bun --cpu-prof`), so there is nothing a running program
 * can start. This reports what it could not do rather than silently writing
 * nothing, and `main` still calls the returned function on every exit path, so
 * the shape of the port matches and a real implementation has somewhere to go.
 */

import { errorln } from "./out.ts";

/** Begins any profiling the environment asks for. */
export function startProfiling(): () => void {
	const cpu = process.env.VALE_CPUPROFILE;
	const mem = process.env.VALE_MEMPROFILE;

	if (cpu !== undefined && cpu !== "") {
		errorln(
			"vale: starting CPU profile: not supported by this build; " +
				"run `bun --cpu-prof` instead",
		);
	}

	return () => {
		if (mem !== undefined && mem !== "") {
			errorln(
				"vale: writing memory profile: not supported by this build; " +
					"run `bun --heap-prof` instead",
			);
		}
	};
}
