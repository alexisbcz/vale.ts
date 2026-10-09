/**
 * The scaffolding the output tests share.
 *
 * A `File` is built as a stand-in rather than through `newFile`, which needs a
 * configuration and a document on disk: the printers read a path and a list of
 * alerts and nothing else, so that is what they are given.
 */

import type { Alert, File } from "@vale-ts/core";
import { newAlert, sortAlerts } from "@vale-ts/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** An alert with the fields a test cares about. */
export function alert(partial: Partial<Alert>): Alert {
	return newAlert({
		severity: "error",
		check: "T.Rule",
		message: "something",
		line: 1,
		span: [1, 2],
		...partial,
	});
}

/** A file holding `alerts`, as the printers read one. */
export function file(p: string, alerts: Alert[]): File {
	return {
		path: p,
		alerts,
		sortedAlerts: () => sortAlerts(alerts),
	} as unknown as File;
}

/** A scratch directory removed when `body` returns. */
export function withTempDir<T>(body: (dir: string) => T): T {
	const dir = mkdtempSync(path.join(tmpdir(), "vale-cli-test-"));
	try {
		return body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A scratch directory that is also the working directory while `body` runs.
 *
 * The working directory is restored before the directory is removed: a `cwd`
 * that no longer exists breaks every test that follows, however the one that
 * made it failed.
 */
export async function inTempDir(
	body: (dir: string) => Promise<void> | void,
): Promise<void> {
	const dir = mkdtempSync(path.join(tmpdir(), "vale-cli-test-"));
	const cwd = process.cwd();
	try {
		process.chdir(dir);
		await body(dir);
	} finally {
		process.chdir(cwd);
		rmSync(dir, { recursive: true, force: true });
	}
}
