/**
 * Fetching a package, and the shapes a package's metadata comes in.
 *
 * The one network call Vale makes outside `sync` is here too: downloading an
 * archive and unpacking it into a directory.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { newE100 } from "@vale-ts/core";
import { unarchive } from "./unarchive.ts";

/** An externally hosted style, as the package library lists it. */
export interface Style {
	author: string;
	description: string;
	deps: string;
	feed: string;
	homepage: string;
	name: string;
	url: string;

	has_update?: boolean;
	in_library?: boolean;
	installed?: boolean;
	addon?: boolean;
}

/** An installed style's `meta.json`. */
export interface Meta {
	author?: string;
	coverage?: number;
	description?: string;
	email?: string;
	feed?: string;
	lang?: string;
	license?: string;
	name?: string;
	sources?: string[];
	url?: string;
	/** `vale_version`: the Vale this release needs. */
	vale_version?: string;
	version?: string;

	/**
	 * The package's releases and the Vale each needs, so `sync` can pick one
	 * without walking a host's feed. See `pkgver.ts`.
	 */
	releases?: Release[];
}

/** One entry of a package's release manifest. */
export interface Release {
	version: string;
	vale_version?: string;
	url: string;
}

/** Downloads `src` and unpacks it into `dst`. */
export async function fetchArchive(src: string, dst: string): Promise<void> {
	let resp: Response;
	try {
		resp = await fetch(src);
	} catch (err) {
		// `fetch` rejects for a URL it cannot even dial, which is how a
		// mistyped package reaches the caller's "not a valid URL" message.
		throw new Error(
			`unsupported protocol scheme or unreachable host: ${messageOf(err)}`,
		);
	}

	if (!resp.ok) {
		throw new Error(`could not fetch '${src}' (status code '${resp.status}')`);
	}

	// A temporary file rather than a buffer, so the ZIP reader sees the same
	// bytes a local `.zip` package would hand it.
	const dir = mkdtempSync(path.join(tmpdir(), "vale-"));
	const archive = path.join(dir, "temp.zip");

	try {
		writeFileSync(archive, new Uint8Array(await resp.arrayBuffer()));
		unarchive(archive, dst);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A temporary directory named after `prefix`. */
export function tempDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

/** Wraps a download failure the way `sync` reports one. */
export function downloadError(url: string, err: unknown): Error {
	const msg = messageOf(err);
	if (msg.includes("unsupported protocol scheme")) {
		return newE100(
			"download",
			new Error(`'${url}' is not a valid URL or the directory doesn't exist`),
		);
	}
	return newE100("download", err);
}
