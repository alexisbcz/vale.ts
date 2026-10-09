/**
 * Comment extraction over Vale's own fixtures, and over the languages read by
 * the fallback scanner.
 *
 * Go compares each fixture against a JSON snapshot
 * (`internal/lint/code/comments_test.go`). Snapshots of this port's own output
 * would assert nothing, so these tests pin the properties the snapshots exist
 * to protect instead: how many comments a file holds, where each one starts,
 * which scope it has, and that its text is prose with the delimiters gone.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { sanitize } from "@vale-ts/core";
import {
	type Comment,
	getComments,
	getLanguageFromExt,
	initCode,
} from "../src/code/index.ts";

beforeAll(async () => {
	await initCode();
});

const FIXTURES = path.join(import.meta.dir, "fixtures", "comments");

function fixture(name: string): Comment[] {
	// `sanitize`, because that is what the linter hands the extractor: a file's
	// content has its line endings normalized before any reader sees it. Read
	// raw, a fixture checked out with CRLF puts a `\r` on the end of every
	// comment.
	const src = sanitize(readFileSync(path.join(FIXTURES, name), "utf8"));
	return getComments(src, getLanguageFromExt(path.extname(name)));
}

/** Each comment as `line:offset scope` plus its first line of prose. */
function describeComments(found: readonly Comment[]): string[] {
	return found.map(
		(c) =>
			`${c.line}:${c.offset} ${c.scope} ${JSON.stringify(c.text.split("\n")[0])}`,
	);
}

describe("a Go file", () => {
	test("the package comment, the doc comment and the trailing one", () => {
		expect(describeComments(fixture("0.go"))).toEqual([
			// A block comment's first line is the `/*` and is empty once the
			// delimiter comes off; the prose begins on the line after it.
			'1:0 text.comment.block ""',
			'11:0 text.comment.line "Println formats using the default formats for its oprands and writes to"',
			'21:14 text.comment.line "foo bar"',
		]);
	});

	test("a run of line comments is one comment", () => {
		const doc = fixture("0.go")[1];
		expect(doc.text).toContain("Spaces are always added between operands");
		expect(doc.text).toContain("It returns the number of bytes written");
		// One line of text per line of source: a blank `//` contributes its
		// newline and nothing else. See #1022.
		expect(doc.text.split("\n").length).toBe(doc.source.split("\n").length);
	});
});

describe("a YAML file", () => {
	test("the header block and the trailing comment", () => {
		const found = fixture("5.yml");
		expect(found).toHaveLength(2);
		expect(found[0].line).toBe(1);
		expect(found[0].text).toContain("This Deployment runs our API component");
		expect(found[1].text).toBe("XXX: Change this to the image you want to use");
	});
});

describe("a Python file", () => {
	test("docstrings and comments both arrive", () => {
		const found = fixture("2.py");
		expect(found.length).toBeGreaterThan(0);
		for (const c of found) {
			expect(c.text.startsWith("#")).toBe(false);
			expect(c.text.startsWith('"""')).toBe(false);
		}
	});

	test("a docstring is a block, and its comments are a run", () => {
		const found = fixture("7.py");
		expect(describeComments(found)).toEqual([
			'1:0 text.comment.line ""',
			'5:4 text.comment.block "c"',
		]);
		// The dedent took the docstring's base indentation off every line but
		// kept what was relative to it.
		expect(found[1].text).toBe("c\nd\n\n");
	});
});

describe("an Elixir file", () => {
	test("the doc attributes get their own meta scope", () => {
		const found = fixture("8.ex");
		const scopes = new Set(found.map((c) => c.scope));
		expect([...scopes].some((s) => s.includes(".doc."))).toBe(true);
	});
});

describe("a JSDoc block", () => {
	test("no line keeps its decoration", () => {
		for (const c of fixture("4.js")) {
			for (const line of c.text.split("\n")) {
				expect(line.trim().startsWith("*")).toBe(false);
			}
		}
	});
});

describe("Kotlin, C# and Rust", () => {
	test("each file yields comments with their delimiters gone", () => {
		for (const name of ["10.kt", "11.kts", "12.cs", "1.rs", "3.cpp"]) {
			const found = fixture(name);
			expect(found.length).toBeGreaterThan(0);
			for (const c of found) {
				expect(c.text.startsWith("//")).toBe(false);
				expect(c.text.startsWith("/*")).toBe(false);
			}
		}
	});
});

/**
 * The languages with no usable grammar, read by their delimiters instead. The
 * comments they produce have the same shape, so everything downstream is
 * identical.
 */
describe("the fallback scanner", () => {
	test("Clojure line comments", () => {
		const found = getComments(
			"(ns app.core)\n\n;; Starts the server.\n;; Twice over.\n(defn -main [] nil)\n",
			getLanguageFromExt(".clj"),
		);
		expect(found).toHaveLength(1);
		expect(found[0].line).toBe(3);
		expect(found[0].text).toBe("Starts the server.\nTwice over.\n");
	});

	test("a PowerShell block comment", () => {
		const found = getComments(
			"<#\n    Gets the thing.\n#>\nfunction Get-Thing {}\n# A note.\n",
			getLanguageFromExt(".ps1"),
		);
		expect(found).toHaveLength(2);
		expect(found[0].scope).toBe("text.comment.block");
		expect(found[0].text).toContain("Gets the thing.");
		expect(found[1].scope).toBe("text.comment.line");
		expect(found[1].text).toBe("A note.");
	});

	test("Julia tells its block opener from its line marker", () => {
		const found = getComments(
			"# A note.\n#=\n   A block.\n=#\nx = 1\n",
			getLanguageFromExt(".jl"),
		);
		expect(found).toHaveLength(2);
		expect(found[0].text).toBe("A note.");
		expect(found[1].scope).toBe("text.comment.block");
		expect(found[1].text).toContain("A block.");
	});

	test("Haskell line and block comments", () => {
		const found = getComments(
			"-- | Adds two numbers.\nadd :: Int -> Int\n{- A block\n   over lines -}\n",
			getLanguageFromExt(".hs"),
		);
		expect(found).toHaveLength(2);
		expect(found[0].text).toContain("Adds two numbers.");
		expect(found[1].scope).toBe("text.comment.block");
	});

	test("a Protocol Buffers comment", () => {
		const found = getComments(
			"// The request.\nmessage Request {\n  /* A field. */\n  string name = 1;\n}\n",
			getLanguageFromExt(".proto"),
		);
		expect(found).toHaveLength(2);
		expect(found[0].text).toBe("The request.");
		// The space before the closing `*/` belongs to the prose, not the
		// delimiter: only the delimiter itself comes off.
		expect(found[1].text).toBe("A field. ");
	});

	test("a block comment opened and closed on one line", () => {
		const found = getComments(
			"x = 1 #= inline block =# + 2\n",
			getLanguageFromExt(".jl"),
		);
		expect(found).toHaveLength(1);
		expect(found[0].offset).toBe(6);
		expect(found[0].text).toBe("inline block ");
	});
});

/**
 * A shebang names an interpreter, and a directive is addressed to a tool.
 * Neither is prose. See #631.
 */
describe("what is dropped before anything is read", () => {
	test("a leading shebang", () => {
		const found = getComments(
			"#!/usr/bin/env python3\n# A real comment.\nx = 1\n",
			getLanguageFromExt(".py"),
		);
		expect(found).toHaveLength(1);
		expect(found[0].text).toBe("A real comment.");
	});

	test("a `#!` anywhere else stays a comment", () => {
		const found = getComments(
			"x = 1\n#!not a shebang\n",
			getLanguageFromExt(".py"),
		);
		expect(found).toHaveLength(1);
	});

	test("a Go build constraint", () => {
		const found = getComments(
			"//go:build linux\n\n// Real prose here.\npackage main\n",
			getLanguageFromExt(".go"),
		);
		expect(found).toHaveLength(1);
		expect(found[0].text).toBe("Real prose here.");
	});

	test("a linter suppression", () => {
		const found = getComments(
			"x = 1  # noqa: E501\n# Real prose here.\n",
			getLanguageFromExt(".py"),
		);
		expect(found).toHaveLength(1);
		expect(found[0].text).toBe("Real prose here.");
	});
});
