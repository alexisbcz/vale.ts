/**
 * Unpacking an archive, and the two things it refuses to do.
 *
 * A port of `internal/system/zip_test.go`, plus the size bound Go enforces by
 * truncating and this refuses outright.
 */

import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	destinationFor,
	MAX_UNARCHIVED_FILE,
	unarchive,
} from "../src/unarchive.ts";
import { withTempDir } from "./helpers.ts";

/** An archive holding the given name/content pairs. */
function archive(dir: string, entries: Record<string, string>): string {
	const files: Record<string, Uint8Array> = {};
	for (const [name, body] of Object.entries(entries)) {
		files[name] = new TextEncoder().encode(body);
	}
	const at = path.join(dir, "test.zip");
	writeFileSync(at, zipSync(files));
	return at;
}

describe("unarchive", () => {
	test("writes every entry, nested directories included", () => {
		withTempDir((dir) => {
			const src = archive(dir, { "a.txt": "alpha", "sub/b.txt": "beta" });
			const dest = path.join(dir, "out");

			unarchive(src, dest);

			expect(readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("alpha");
			expect(readFileSync(path.join(dest, "sub", "b.txt"), "utf8")).toBe("beta");
		});
	});

	test("creates the destination when it is not there", () => {
		withTempDir((dir) => {
			const src = archive(dir, { "a.txt": "x" });
			const dest = path.join(dir, "deep", "out");
			unarchive(src, dest);
			expect(existsSync(path.join(dest, "a.txt"))).toBe(true);
		});
	});

	test("refuses a path outside the destination, however it is spelled", () => {
		for (const name of ["../escaped.txt", "sub/../../escaped.txt"]) {
			withTempDir((dir) => {
				const dest = path.join(dir, "out");
				const src = archive(dir, { [name]: "nope" });

				expect(() => unarchive(src, dest)).toThrow("invalid file path");

				// Nothing may reach the parent, which is what the refusal is
				// there to prevent.
				expect(existsSync(path.join(dir, "escaped.txt"))).toBe(false);
			});
		}
	});

	test("an absolute entry is contained rather than obeyed", () => {
		// `path.join` drops the leading separator, as Go's `filepath.Join`
		// does, so the entry lands under the destination instead of at the
		// root it names.
		withTempDir((dir) => {
			const dest = path.join(dir, "out");
			const src = archive(dir, { "/etc/passwd": "nope" });

			unarchive(src, dest);

			expect(existsSync(path.join(dest, "etc", "passwd"))).toBe(true);
		});
	});
});

describe("destinationFor", () => {
	test("resolves an ordinary entry under the destination", () => {
		expect(destinationFor("/d", "sub/a.txt")).toBe(path.join("/d", "sub/a.txt"));
		expect(destinationFor("/d", "./a.txt")).toBe(path.join("/d", "a.txt"));
	});

	test("the destination itself is not a valid entry", () => {
		expect(() => destinationFor("/d", "")).toThrow("invalid file path");
		expect(() => destinationFor("/d", ".")).toThrow("invalid file path");
	});

	test("a sibling that merely shares a prefix is still outside", () => {
		expect(() => destinationFor("/d", "../delta/a.txt")).toThrow(
			"invalid file path",
		);
	});

	test("the bound is Go's", () => {
		expect(MAX_UNARCHIVED_FILE).toBe(10 * 1024 * 1024 * 1024);
	});
});
