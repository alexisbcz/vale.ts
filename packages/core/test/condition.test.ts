/**
 * A section header's `if`.
 *
 * Ported from `internal/core/condition_test.go`. Go's `NewFileFields` takes the
 * whole `Config` to find the root `.vale.ini`; the port takes that path, which
 * is all it reads.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { Condition, newFileFields, splitSection } from "../src/condition.ts";

describe("splitSection", () => {
	const cases: Array<{ label: string; glob: string; cond: string }> = [
		{ label: "*.md", glob: "*.md", cond: "" },
		{ label: "*.md if .Meta.draft", glob: "*.md", cond: ".Meta.draft" },
		{
			label: 'docs/*.md if .Name == "a if b"',
			glob: "docs/*.md",
			cond: '.Name == "a if b"',
		},
		{ label: "*.{md,txt}", glob: "*.{md,txt}", cond: "" },
	];

	test.each(cases)("$label", ({ label, glob, cond }) => {
		expect(splitSection(label)).toEqual([glob, cond]);
	});
});

describe("Condition", () => {
	const root = mkdtempSync(nodePath.join(tmpdir(), "vale-cond-"));
	const rootINI = nodePath.join(root, ".vale.ini");

	const yaml = "---\npublished: false\ntags: [a, b]\n---\n\nText.\n";
	const toml = "+++\ndraft = true\n+++\n\nText.\n";

	const cases: Array<{
		expr: string;
		path: string;
		content: string;
		want: boolean;
	}> = [
		{ expr: ".Meta.published == false", path: "post.md", content: yaml, want: true },
		{
			expr: ".Meta.published == false",
			path: "post.md",
			content: "Text.\n",
			want: false,
		},
		{ expr: ".Meta.draft", path: "post.md", content: toml, want: true },
		{ expr: ".Meta.draft", path: "post.md", content: yaml, want: false },
		{
			expr: ".Meta.published == false or .Meta.draft",
			path: "post.md",
			content: "Text.\n",
			want: false,
		},
		{
			expr: ".Meta.draft or .Meta.published == false",
			path: "post.md",
			content: yaml,
			want: true,
		},
		{
			expr: 'not .Meta.draft and .Ext == ".md"',
			path: "post.md",
			content: yaml,
			want: true,
		},
		{ expr: '"b" in .Meta.tags', path: "post.md", content: yaml, want: true },
		{
			expr: '"b" in .Meta.tags',
			path: "post.md",
			content: "Text.\n",
			want: false,
		},
		{
			expr: '.Name == "post.md" and .Ext == ".md"',
			path: "post.md",
			content: "",
			want: true,
		},
		{
			expr: '.Path == "docs/a/post.md" and .Dir == "docs/a"',
			path: nodePath.join(root, "docs", "a", "post.md"),
			content: "",
			want: true,
		},
	];

	test.each(cases)("$expr on $path", ({ expr, path, content, want }) => {
		const cond = new Condition(expr);
		expect(
			cond.holds(newFileFields(path, content, cond.readsMeta, rootINI)),
		).toBe(want);
	});
});

describe("Condition errors", () => {
	// An expression that cannot be read, and one that is not a condition: Go
	// compiles with `expr.AsBool()`, which refuses the second.
	test.each([".Meta.published ==", '"text"'])("%p", (bad) => {
		expect(() => new Condition(bad)).toThrow();
	});
});
