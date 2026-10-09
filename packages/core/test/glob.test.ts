/**
 * The glob patterns a `.vale.ini` section header is written in.
 *
 * Ported from `internal/glob/glob_test.go`.
 */

import { describe, expect, test } from "bun:test";
import { compileGlob } from "../src/glob.ts";

interface GlobCase {
	pattern: string;
	tests: Array<{ query: string; match: boolean }>;
}

const globTests: GlobCase[] = [
	{
		pattern: "docs/**",
		tests: [
			{ query: "docs/a.md", match: true },
			{ query: "docs/info/b.py", match: true },
			{ query: "info/c.cc", match: false },
		],
	},
	{
		pattern: "!docs/**",
		tests: [
			{ query: "docs/a.md", match: false },
			{ query: "docs/info/b.py", match: false },
			{ query: "info/c.cc", match: true },
		],
	},
	{
		pattern: "!**/*.min.js",
		tests: [
			{ query: "a/b/c/foo.py", match: true },
			{ query: "a/b/c/foo.min.js", match: false },
		],
	},
	{
		pattern: "docs/**/*.md",
		tests: [
			{ query: "docs/a.md", match: true },
			{ query: "docs/info/b.md", match: true },
			{ query: "docs/c.cc", match: false },
		],
	},
	{
		pattern: "{documentation,website}/content/{ja,zh-tw}/**/*.adoc",
		tests: [
			{ query: "website/content/zh-tw/where.adoc", match: true },
			{ query: "documentation/content/ja/articles/test.adoc", match: true },
		],
	},
];

/**
 * Patterns doublestar accepts and gobwas/glob rejects. Compiling has to report
 * them, since `match` can't: it used to compile with `MustCompile` and panicked
 * partway through the walk.
 */
const invalidGlobs = ["[a-]", "[a-b-c]"];

describe("compileGlob", () => {
	test("reports an invalid pattern", () => {
		for (const pat of invalidGlobs) {
			expect(() => compileGlob(pat)).toThrow();
		}
	});

	test("matches", () => {
		for (const tt of globTests) {
			const g = compileGlob(tt.pattern);
			for (const tc of tt.tests) {
				expect(g.match(tc.query), `${tt.pattern} -> ${tc.query}`).toBe(tc.match);
			}
		}
	});

	// Not from the Go suite: the two shapes above are the only ones the glob
	// libraries disagree about, so the classes a configuration really writes
	// have to keep working.
	test("keeps the character classes a configuration writes", () => {
		expect(compileGlob("[Pp]ython/*.md").match("Python/a.md")).toBe(true);
		expect(compileGlob("[a-zA-Z]*.md").match("Readme.md")).toBe(true);
		expect(compileGlob("*.[ch]").match("main.c")).toBe(true);
		expect(compileGlob("[!_]*.md").match("_draft.md")).toBe(false);
	});

	test("matchAny", () => {
		const g = compileGlob("*.md");
		expect(g.matchAny(["a.txt", "b.md"])).toBe(true);
		expect(g.matchAny(["a.txt", "b.rst"])).toBe(false);
	});
});
