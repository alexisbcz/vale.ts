/**
 * Ports of the `fileToValue` and scalar-position tests in
 * `internal/core/view_test.go`.
 *
 * A scalar's reported line and column are what place an alert, so the cases
 * where the position is not the start of the token -- a quoted scalar, a block
 * scalar, a scalar folded over several lines -- carry the weight here. The
 * fixture positions are cross-checked against the alerts Vale's own e2e suite
 * expects from them.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { selectStrings } from "../src/dasel.ts";
import {
	blockScalarContentStart,
	fileToValue,
	foldedToLiteral,
	newPart,
	newScalarResolver,
	newSource,
	positionAt,
	type ScalarPos,
} from "../src/structured.ts";

const FIXTURES = `${import.meta.dir}/fixtures`;

function read(name: string, realExt?: string) {
	const dot = name.lastIndexOf(".");
	return fileToValue({
		content: readFileSync(`${FIXTURES}/${name}`, "utf8"),
		realExt: realExt ?? name.slice(dot),
	});
}

describe("a scalar is placed at its first content character", () => {
	const cases: Array<[string, string, string, ScalarPos[]]> = [
		[
			"plain scalar",
			".yaml",
			"info:\n  title: sample API\n",
			[{ value: "sample API", line: 2, column: 10, quote: "" }],
		],
		[
			// The parser reports the opening quote at column 16; the position
			// steps past it.
			"double-quoted with a line continuation",
			".yaml",
			'info:\n  description: "Line 1\\\n    \\ Line 2"\n',
			[{ value: "Line 1 Line 2", line: 2, column: 17, quote: '"' }],
		],
		[
			// The indicator is on line 2; the content starts on line 3.
			"literal block scalar",
			".yaml",
			"info:\n  description: |\n    First line\n    Second line\n",
			[
				{
					value: "First line\nSecond line\n",
					line: 3,
					column: 5,
					quote: "",
				},
			],
		],
		[
			// A trailing space after "First line." -- the scenario from issue
			// #1018. Once the folded indicator is rewritten to a literal one
			// the value carries newlines, so the walk reports the first
			// content line and column.
			"folded block with trailing whitespace",
			".yaml",
			"info:\n  description: >\n    First line. \n    Second line.\n",
			[
				{
					value: "First line. \nSecond line.\n",
					line: 3,
					column: 5,
					quote: "",
				},
			],
		],
		[
			"single-quoted",
			".yaml",
			"title: 'sample'\n",
			[{ value: "sample", line: 1, column: 9, quote: "'" }],
		],
		[
			"an indented block under a sequence",
			".yaml",
			"- goal: |-\n    Only line.\n",
			[{ value: "Only line.", line: 2, column: 5, quote: "" }],
		],
		[
			"a block whose first line is blank",
			".yaml",
			"a: |\n\n  text\n",
			[{ value: "\ntext\n", line: 3, column: 3, quote: "" }],
		],
	];

	for (const [name, realExt, content, want] of cases) {
		test(name, () => {
			expect(fileToValue({ content, realExt }).scalars).toEqual(want);
		});
	}

	test("a column counts characters, not code units", () => {
		const { scalars } = fileToValue({
			content: "k: héllo wörld\n",
			realExt: ".yaml",
		});
		expect(scalars).toEqual([
			{ value: "héllo wörld", line: 1, column: 4, quote: "" },
		]);
		// An astral character is one column wide.
		const emoji = fileToValue({
			content: 'a: "\u{1F600}"\nb: here\n',
			realExt: ".yaml",
		});
		expect(emoji.scalars[1]).toEqual({
			value: "here",
			line: 2,
			column: 4,
			quote: "",
		});
	});
});

describe("Vale's own fixtures", () => {
	// The positions the e2e suite's expected alerts are built from.
	test("API.yml", () => {
		const { scalars } = read("API.yml");
		const byValue = new Map(scalars.map((s) => [s.value, s]));
		expect(byValue.get("sample API")).toEqual({
			value: "sample API",
			line: 3,
			column: 10,
			quote: "",
		});
		// The staging server's description is a literal block: line 11 holds
		// the indicator, line 12 the first content line.
		expect(
			byValue.get(
				"Optional server description, e.g.\nInternal staging serrver for testing\n",
			),
		).toEqual({
			value:
				"Optional server description, e.g.\nInternal staging serrver for testing\n",
			line: 12,
			column: 7,
			quote: "",
		});
	});

	test("ansible.yml", () => {
		const { scalars } = read("ansible.yml");
		// A double-quoted title, placed past its quote.
		expect(scalars[1]).toEqual({
			value: "reusing Code with Ansible Roles and Coent Collections",
			line: 3,
			column: 13,
			quote: '"',
		});
		// A `|-` block, placed on its content line.
		expect(scalars[2]!.line).toBe(5);
		expect(scalars[2]!.column).toBe(7);
		expect(scalars[2]!.quote).toBe("");
	});

	test("issue1018.yml", () => {
		const { value, scalars } = read("issue1018.yml");
		expect(scalars).toEqual([
			{ value: "3.0.1", line: 1, column: 10, quote: "" },
			{
				value: "Contains misspeling when wrapped",
				line: 3,
				column: 17,
				quote: '"',
			},
			{
				value: "Includes trailing space.\nHas misspeled second line.\n",
				line: 6,
				column: 5,
				quote: "",
			},
		]);
		// The folded summary keeps its newline, which is what puts the second
		// line's misspelling on line 7.
		expect(selectStrings(value, "info.summary")).toEqual([
			"Includes trailing space.\nHas misspeled second line.\n",
		]);
	});

	test("every scalar of a large JSON document is placed", () => {
		const { scalars } = read("github-workflow.json");
		expect(scalars.length).toBeGreaterThan(800);
		for (const s of scalars) {
			expect(s.line).toBeGreaterThan(0);
			expect(s.column).toBeGreaterThan(0);
		}
	});
});

describe("fileToValue", () => {
	test("a top-level array is a document root", () => {
		// Issue #1017: a document need not be an object.
		const cases: Array<[string, string]> = [
			[".json", '[\n  {"title": "first"},\n  {"title": "second"}\n]\n'],
			[".yaml", "- title: first\n- title: second\n"],
		];
		for (const [realExt, content] of cases) {
			const { value } = fileToValue({ content, realExt });
			expect(selectStrings(value, "all().title")).toEqual(["first", "second"]);
		}
	});

	test("a file a section matched is read whatever it is called", () => {
		const { value } = fileToValue({
			realExt: ".log",
			content: '{"messages":[{"role":"assistant","content":"answered"}]}',
		});
		expect(selectStrings(value, "messages.all().content")).toEqual(["answered"]);
	});

	test("JSON is decoded as JSON and reparsed for positions", () => {
		const { value, scalars } = fileToValue({
			realExt: ".json",
			content: '{\n  "a": "x",\n  "n": 2\n}\n',
		});
		expect(value).toEqual({ a: "x", n: 2 });
		expect(scalars).toEqual([
			{ value: "x", line: 2, column: 9, quote: '"' },
			// A number is matched as it was written.
			{ value: "2", line: 3, column: 8, quote: "" },
		]);
	});

	test("TOML is read for its value alone", () => {
		const { value, scalars } = fileToValue({
			realExt: ".toml",
			content: '# a comment\ntitle = "A guide to the storage layer"\n',
		});
		expect(value).toEqual({ title: "A guide to the storage layer" });
		// The TOML parser gives no positions, so a value from it is placed by
		// a textual search instead.
		expect(scalars).toEqual([]);
	});

	test("an empty document, and one that cannot be parsed", () => {
		expect(() => fileToValue({ realExt: ".yaml", content: "" })).toThrow(
			"document root is empty",
		);
		expect(() => fileToValue({ realExt: ".yaml", content: "a: [\n" })).toThrow();
		expect(() => fileToValue({ realExt: ".json", content: "{nope}" })).toThrow();
	});

	test("a mapping's keys are not scalars a selector can return", () => {
		const { scalars } = fileToValue({
			realExt: ".yaml",
			content: "key: value\nother: thing\n",
		});
		expect(scalars.map((s) => s.value)).toEqual(["value", "thing"]);
	});

	test("an alias is read as the node it names, at the anchor's position", () => {
		const { scalars } = fileToValue({
			realExt: ".yaml",
			content: "a: &x hello\nb: *x\n",
		});
		expect(scalars).toEqual([
			{ value: "hello", line: 1, column: 7, quote: "" },
			{ value: "hello", line: 1, column: 7, quote: "" },
		]);
	});
});

test("foldedToLiteral rewrites only a folded indicator", () => {
	// A `|` block and a `>` inside a string value are left alone.
	expect(foldedToLiteral('a: >\n  one\n  two\nb: |\n  literal\nc: "x > y"\n')).toBe(
		'a: |\n  one\n  two\nb: |\n  literal\nc: "x > y"\n',
	);
	// Nothing to do, so the source comes back as it was.
	expect(foldedToLiteral("a: plain\n")).toBe("a: plain\n");
});

test("blockScalarContentStart skips the blank lines under the indicator", () => {
	const lines = ["a: |", "", "   ", "    text", ""];
	expect(blockScalarContentStart(lines, 1)).toEqual([4, 5]);
	// An empty block falls back to the line after the indicator.
	expect(blockScalarContentStart(["a: |", ""], 1)).toEqual([2, 1]);
});

test("the resolver hands out each scalar once, in document order", () => {
	const r = newScalarResolver([
		{ value: "shared", line: 1, column: 5, quote: "" },
		{ value: "unique", line: 2, column: 5, quote: "" },
		{ value: "shared", line: 3, column: 5, quote: "" },
	]);
	expect(r.locate("shared")?.line).toBe(1);
	expect(r.locate("shared")?.line).toBe(3);
	expect(r.locate("shared")).toBeNull();
	expect(r.locate("unique")?.line).toBe(2);
	expect(r.locate("missing")).toBeNull();
});

test("issue #1018: a double-quoted scalar with a line continuation", () => {
	// Before the fix, Vale could not locate "Line 1 Line 2" in the source.
	const { value, scalars } = fileToValue({
		realExt: ".yaml",
		content: 'openapi: 3.0.1\ninfo:\n  description: "Line 1\\\n    \\ Line 2"\n',
	});
	expect(selectStrings(value, "info.description")).toEqual(["Line 1 Line 2"]);

	const r = newScalarResolver(scalars);
	r.locate("3.0.1"); // walk past the version
	expect(r.locate("Line 1 Line 2")).toEqual({
		value: "Line 1 Line 2",
		line: 3,
		column: 17,
		quote: '"',
	});
});

describe("source positions", () => {
	const src = newSource("one\ntwö\n\nfour\n");

	test("positionAt", () => {
		expect(positionAt(src, 0)).toEqual([1, 1]);
		expect(positionAt(src, 3)).toEqual([1, 4]);
		expect(positionAt(src, 4)).toEqual([2, 1]);
		expect(positionAt(src, 8)).toEqual([3, 1]);
		expect(positionAt(src, 9)).toEqual([4, 1]);
	});

	test("newPart keeps the source line from the column on", () => {
		expect(
			newPart(src.lines, { value: "wö", line: 2, column: 2, quote: "" }, 7),
		).toEqual({ offset: 7, line: 2, column: 2, quote: "", raw: "wö" });
		// A column past the end of the line leaves the raw text empty.
		expect(
			newPart(src.lines, { value: "", line: 3, column: 1, quote: "" }, 0).raw,
		).toBe("");
	});
});
