/**
 * The small helpers the rest of the port shares, plus the format and path
 * questions asked about a file.
 *
 * Ported from `internal/core/util_test.go`. Go keeps `FormatFromExt` and
 * `NormalizePath` in `format.go` and `ShouldIgnoreDirectory` in `util.go`; the
 * port splits them between `format.ts`, `util.ts` and `system.ts`, so the
 * cases follow the Go test file rather than the port's file layout.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { Alert } from "../src/alert.ts";
import { newAlert } from "../src/alert.ts";
import { File } from "../src/file.ts";
import { formatFromExt, normalizePathFormat } from "../src/format.ts";
import { normalizePath } from "../src/system.ts";
import {
	checkName,
	findShifts,
	isPhrase,
	sanitize,
	shouldIgnoreDirectory,
	styleName,
} from "../src/util.ts";

describe("formatFromExt", () => {
	const extToFormat: Record<string, [string, string]> = {
		".py": [".py", "code"],
		".cxx": [".cpp", "code"],
		".mdown": [".md", "markup"],
		".Rmd": [".md", "markup"],
		".rmd": [".md", "markup"],
		".R": [".r", "code"],
		".qml": [".qml", "code"],
	};

	test("a bare extension", () => {
		for (const [ext, want] of Object.entries(extToFormat)) {
			expect(formatFromExt(ext, {}), ext).toEqual(want);
		}
	});

	// Markup embedded in code: the normed extension is the markup one and the
	// format is `fragment`, so the comments are read as prose.
	test("an extension `[formats]` remaps", () => {
		const mapped = { cpp: "qdoc", qml: "qdoc" };
		for (const ext of [".cpp", ".qml"]) {
			expect(formatFromExt(ext, mapped), ext).toEqual([".qdoc", "fragment"]);
		}
	});

	// A `[formats]` key may name a file or a glob, not only an extension.
	test("a key naming a file or a glob", () => {
		const mapping = {
			COMMIT_EDITMSG: "md",
			Makefile: "rst",
			"notes/*.txt": "md",
			"*.log": "adoc",
			ts: "js",
		};

		const cases: Record<string, [string, string]> = {
			".git/COMMIT_EDITMSG": [".md", "markup"],
			Makefile: [".rst", "markup"],
			"notes/today.txt": [".md", "markup"],
			"other/today.txt": [".txt", "text"],
			"build.log": [".adoc", "markup"],
			"src/app.ts": [".js", "code"],
			LICENSE: ["unknown", "unknown"],
		};
		for (const [path, want] of Object.entries(cases)) {
			expect(formatFromExt(path, mapping), path).toEqual(want);
		}

		const normed: Record<string, string> = {
			".git/COMMIT_EDITMSG": ".git/COMMIT_EDITMSG.md",
			"notes/today.txt": "notes/today.md",
			"other/today.txt": "other/today.txt",
			"src/app.ts": "src/app.js",
		};
		for (const [path, want] of Object.entries(normed)) {
			expect(normalizePathFormat(path, mapping), path).toBe(want);
		}
	});
});

describe("sanitize", () => {
	test("normalizes line endings", () => {
		const rawToPrepped: Record<string, string> = {
			"foo\r\nbar": "foo\nbar",
			"foo\r\n\r\nbar": "foo\n\nbar",
		};
		for (const [raw, prepped] of Object.entries(rawToPrepped)) {
			expect(sanitize(raw)).toBe(prepped);
		}
	});
});

describe("findShifts", () => {
	test("reports nothing when no entity was rewritten", () => {
		expect(findShifts("no entities here\n")).toBeNull();
	});

	test("records the column of each rewrite, by line", () => {
		const got = findShifts("a&rsquo;b\nplain\nx &rsquo; y&rsquo;\n");
		expect(got).not.toBeNull();
		expect([...(got as Map<number, number[]>).entries()]).toEqual([
			[1, [2]],
			[3, [3, 6]],
		]);
	});
});

describe("mapAlertsToSource", () => {
	test("shifts and widens the spans the rewrite moved", () => {
		const f = new File();
		f.alerts = [
			// The rewrite sits inside the match: the span widens.
			newAlert({ line: 1, span: [13, 16] }),
			// The rewrite precedes the match: the span shifts.
			newAlert({ line: 2, span: [11, 14] }),
			// A line with no rewrites is untouched.
			newAlert({ line: 3, span: [2, 5] }),
		];
		// `sanShifts` is private, and set from the raw text when the file is
		// read; the Go test builds the File literal with the same field.
		(f as unknown as { sanShifts: Map<number, number[]> }).sanShifts = new Map([
			[1, [15]],
			[2, [6]],
		]);

		f.mapAlertsToSource();

		const want = [
			[13, 22],
			[17, 20],
			[2, 5],
		];
		expect(f.alerts.map((a: Alert) => a.span)).toEqual(want);
	});
});

describe("isPhrase", () => {
	test("tells a plain phrase from a pattern", () => {
		const cases: Record<string, boolean> = {
			"test suite": true,
			"test[ ]?suite": false,
			Google: true,
			"write-good": true,
			"https://vale.sh/explorer": false,
			"Google.zip": false,
		};
		for (const [input, want] of Object.entries(cases)) {
			expect(isPhrase(input), input).toBe(want);
		}
	});
});

describe("normalizePath", () => {
	test("expands a leading tilde", () => {
		expect(normalizePath(nodePath.join("~", ".vale"))).toBe(
			nodePath.join(homedir(), ".vale"),
		);
	});

	test("leaves a real path alone, tilde inside it or not", () => {
		for (const prefix of ["vale_test", "vale~test"]) {
			const dir = mkdtempSync(nodePath.join(tmpdir(), prefix));
			expect(normalizePath(dir)).toBe(dir);
		}
	});
});

describe("shouldIgnoreDirectory", () => {
	const cases: Array<{ name: string; path: string; expected: boolean }> = [
		{ name: "empty directory name", path: "", expected: false },
		// Direct directory names.
		{ name: "direct node_modules", path: "node_modules", expected: true },
		{ name: "direct .git", path: ".git", expected: true },
		// Nested paths with ignored directories.
		{
			name: "nested node_modules",
			path: "plugins/foo/node_modules",
			expected: true,
		},
		{ name: "nested .git in worktree", path: "worktree-a/.git", expected: true },
		{
			name: "deeply nested node_modules",
			path: "project/src/components/node_modules",
			expected: true,
		},
		{
			name: "node_modules in a joined path",
			path: nodePath.join("project", "src", "node_modules"),
			expected: true,
		},
		// Non-ignored directories.
		{ name: "regular directory", path: "src", expected: false },
		{ name: "nested regular directory", path: "plugins/foo", expected: false },
		{
			name: "directory containing node_modules in name",
			path: "my_node_modules_backup",
			expected: false,
		},
		{
			name: "directory containing .git in name",
			path: "my.github",
			expected: false,
		},
	];

	test.each(cases)("$name", ({ path, expected }) => {
		expect(shouldIgnoreDirectory(path)).toBe(expected);
	});
});

describe("styleName", () => {
	test("is the first part of a rule's name", () => {
		const cases: Record<string, string> = {
			"proselint.Typography": "proselint",
			proselint: "proselint",
			"Vale.Spelling": "Vale",
			// A consistency check reports under a third part; the style is still
			// the first one.
			"demo.Consistency.Smart": "demo",
			"": "",
		};
		for (const [input, want] of Object.entries(cases)) {
			expect(styleName(input), input).toBe(want);
		}
	});
});

// `checkName` is what makes a subdirectory part of a rule's identity: the tree
// under the style root joins the name, and the file's base keeps its
// historical first-dot reading.
describe("checkName", () => {
	const cases: Array<[string, string, string]> = [
		["styles/Std", "styles/Std/OxfordComma.yml", "Std.OxfordComma"],
		["styles/Std", "styles/Std/dates/TimeFormat.yml", "Std.dates.TimeFormat"],
		["styles/Std", "styles/Std/a/b/Deep.yml", "Std.a.b.Deep"],
		["styles/Std", "styles/Std/Terms.custom.yml", "Std.Terms"],
	];

	test("joins the tree under the style root", () => {
		for (const [root, path, want] of cases) {
			expect(checkName(root, path), path).toBe(want);
		}
	});

	test("rejects a bracketed rule name", () => {
		expect(() => checkName("styles/Std", "styles/Std/Weird[max].yml")).toThrow();
	});
});
