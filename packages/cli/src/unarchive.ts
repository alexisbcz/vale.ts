/**
 * Unpacking the ZIP archives `sync` downloads.
 *
 * A port of `internal/system/unarchive.go`, kept here because the CLI is the
 * only thing that unpacks anything.
 *
 * Two refusals matter. An entry naming a path outside the destination is
 * rejected rather than written, however it spells the escape -- an archive
 * from the network must not be able to write over a dotfile. And a single
 * entry is bounded, so that a small archive cannot ask for an unbounded write.
 *
 * Where Go differs: it truncates an oversized entry through a `LimitReader`,
 * because it streams. `fflate` decompresses into memory, so an entry over the
 * bound is refused outright instead -- the alternative is to allocate what the
 * bound exists to prevent.
 */

import { unzipSync } from "fflate";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { mkdir } from "@vale-ts/core";

/**
 * What a single archived file may expand to.
 *
 * Go's bound, kept as it is: a style package is kilobytes, and anything near
 * this is not one.
 */
export const MAX_UNARCHIVED_FILE = 10 * 1024 * 1024 * 1024;

/** One entry's name and the size it claims to expand to. */
interface Entry {
	name: string;
	originalSize: number;
}

/**
 * Resolves an entry's name against `dest`, refusing one that leaves it.
 *
 * `path.join` normalizes, so `sub/../../x` and `../x` both resolve out of the
 * destination and both are caught by the prefix test -- which is the point:
 * the check is on the resolved path, not on the spelling.
 */
export function destinationFor(dest: string, name: string): string {
	const destPath = path.join(dest, path.normalize(name));
	const root = path.normalize(dest);

	if (!destPath.startsWith(root + path.sep)) {
		throw new Error(`invalid file path: ${name}`);
	}

	return destPath;
}

/** Extracts a ZIP archive into `dest`. */
export function unarchive(src: string, dest: string): void {
	const data = readFileSync(src);

	// Two passes: the names are checked before anything is decompressed, so a
	// hostile entry is refused before a single byte is written.
	const entries: Entry[] = [];
	unzipSync(data, {
		filter: (file) => {
			entries.push({ name: file.name, originalSize: file.originalSize ?? 0 });
			return false;
		},
	});

	const wanted = new Set<string>();
	mkdir(dest);

	for (const entry of entries) {
		const destPath = destinationFor(dest, entry.name);

		if (entry.name.endsWith("/")) {
			mkdir(destPath);
			continue;
		}
		if (entry.originalSize > MAX_UNARCHIVED_FILE) {
			throw new Error(
				`file too large to extract: ${entry.name} ` +
					`(${entry.originalSize} bytes)`,
			);
		}
		wanted.add(entry.name);
	}

	const files = unzipSync(data, { filter: (file) => wanted.has(file.name) });

	for (const [name, bytes] of Object.entries(files)) {
		const destPath = destinationFor(dest, name);
		mkdir(path.dirname(destPath));
		writeFileSync(destPath, bytes);
	}
}
