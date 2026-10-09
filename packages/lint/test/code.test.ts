/**
 * Comment extraction, per language.
 *
 * Ported from `internal/lint/code/comments_test.go`, `doc_test.go` and
 * `prefix_test.go`. The grammars are loaded once, by `initCode`; the fallback
 * scanner needs nothing.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
	appendLine,
	type Comment,
	getComments,
	getLanguageFromExt,
	goDoc,
	initCode,
	javadoc,
	jsDoc,
	kDoc,
	type Mask,
	masked,
	pyDoc,
	rustDoc,
	stripAt,
} from "../src/code/index.ts";
import { CommentBuilder } from "../src/code/query.ts";
import { C_STYLE_PREFIX } from "../src/code/util.ts";

beforeAll(async () => {
	await initCode();
});

function comments(ext: string, src: string): Comment[] {
	return getComments(src, getLanguageFromExt(ext));
}

describe("appendLine", () => {
	test("normalizes trailing newlines", () => {
		const want: Record<string, string> = {
			"": "\n",
			text: "text\n",
			"text\n": "text\n",
			"text\n\n": "text\n",
			"  text\n\n": "text\n",
		};
		for (const [input, expected] of Object.entries(want)) {
			expect(appendLine(input)).toBe(expected);
		}
	});
});

/**
 * The underscore convention: a capture that exists for a predicate to test is
 * not itself linted.
 *
 * Without it, testing one node and extracting another is impossible -- the
 * only testable node is the one you extract -- which is what the Elixir doc
 * attributes need: the attribute name decides, the heredoc is the prose.
 */
test("a predicate-only capture is not linted", () => {
	const found = comments(".ex", 'defmodule M do\n  @moduledoc "Prose."\nend\n');
	expect(found).toHaveLength(1);
	expect(found[0].text).toBe("Prose.");
});

/**
 * The attributes that hold no prose: `@doc false` hides a function and
 * `@doc since:` is metadata. Neither has a string argument, so neither is
 * extracted.
 */
test("doc attributes without prose are not extracted", () => {
	const found = comments(
		".ex",
		'defmodule M do\n  @doc false\n  @doc since: "1.0.0"\n  def f, do: :ok\nend\n',
	);
	expect(found).toHaveLength(0);
});

/**
 * Edge-only stripping: a delimiter character inside a comment's prose -- the
 * `//` of a URL, the `#` of a Markdown heading -- is content, and taking it
 * out shifted every alert to its right by its width.
 */
describe("delimiters inside prose", () => {
	const cases: Array<[string, string, string, string]> = [
		[
			"a URL in a line comment",
			".go",
			"package main\n\n// See https://example.com for details.\nfunc main() {}\n",
			"See https://example.com for details.",
		],
		[
			"a hash in a line comment",
			".py",
			"# Use the #id selector here.\n",
			"Use the #id selector here.",
		],
		[
			"a doubled marker comes off whole",
			".py",
			"## A banner-style comment.\n",
			"A banner-style comment.",
		],
		[
			"a heading in a doc attribute",
			".ex",
			'defmodule M do\n  @moduledoc """\n  Does things.\n\n  ## Examples\n\n      M.run()\n  """\nend\n',
			"Does things.\n\n## Examples\n\n    M.run()\n\n",
		],
		[
			"a heading in a docstring",
			".py",
			'def f():\n    """Does things.\n\n    ## Examples\n\n    f()\n    """\n    pass\n',
			"Does things.\n\n## Examples\n\nf()\n\n",
		],
	];

	for (const [name, ext, src, want] of cases) {
		test(name, () => {
			const found = comments(ext, src);
			expect(found).toHaveLength(1);
			expect(found[0].text.replace(/\n+$/, "")).toBe(want.replace(/\n+$/, ""));
		});
	}
});

/**
 * `C_STYLE_PREFIX` decides what is decoration and what is content. Getting
 * this wrong deletes markup rather than exposing it, so the boundary cases are
 * spelled out.
 */
describe("the C-style per-line prefix", () => {
	const cases: Array<[string, string, string]> = [
		["jsdoc line", " * Some text.", " *"],
		["no leading space", "* Some text.", "*"],
		["tab indented", "\t\t* Some text.", "\t\t*"],
		["empty jsdoc line", " *", " *"],
		["star then tab", " *\tSome text.", " *"],
		// The star is content in all of these.
		["emphasis at line start", " *emphasis* here.", ""],
		["bold at line start", " **bold** here.", ""],
		["no star at all", " Some text.", ""],
		["star after text", "Some * text.", ""],
		["blank line", "", ""],
	];

	for (const [name, line, want] of cases) {
		test(name, () => {
			const m = C_STYLE_PREFIX.exec(line);
			expect(m === null ? "" : m[1]).toBe(want);
		});
	}
});

describe("blanking the per-line decoration", () => {
	function blanked(prefix: RegExp | null, s: string): string {
		const lang = getLanguageFromExt(".js");
		lang.prefix = prefix;
		lang.cutset = " ";
		return new CommentBuilder(lang).blankPrefixes(s);
	}

	/**
	 * Blanking must not move anything: the dedent that follows is the only step
	 * allowed to change a column, and it is the only step that reports one.
	 */
	test("the width is preserved", () => {
		for (const input of [
			" * Some text.",
			" *\n * More.\n *",
			" * * a list item",
			" *emphasis* stays",
			"no decoration here",
		]) {
			expect(blanked(C_STYLE_PREFIX, input).length).toBe(input.length);
		}
	});

	test("markup survives", () => {
		const cases: Array<[string, string, string]> = [
			["plain line", " * Some text.", "   Some text."],
			["empty line", " *", "  "],
			// The second star is a list marker and has to survive.
			["list item", " * * a list item", "   * a list item"],
			["emphasis", " *emphasis* here", " *emphasis* here"],
			["indented code", " *     code()", "       code()"],
		];
		for (const [, input, want] of cases) {
			expect(blanked(C_STYLE_PREFIX, input)).toBe(want);
		}
	});

	test("a language with no prefix is untouched", () => {
		const input = " * Some text.\n * More.";
		expect(blanked(null, input)).toBe(input);
	});
});

/**
 * A JSDoc block has to reach the Markdown parser as paragraphs, not as a
 * bullet list -- the whole point of the exercise.
 */
test("a JSDoc block becomes clean Markdown", () => {
	const found = comments(
		".js",
		"/**\n * Formats the value for display.\n *\n * @example\n * const x = format(y);\n */\n",
	);
	expect(found).toHaveLength(1);

	for (const line of found[0].text.split("\n")) {
		expect(line.trim().startsWith("*")).toBe(false);
	}
	expect(found[0].text).toContain("Formats the value for display.");
});

/**
 * `strip` is what lets an alert be put back exactly. It has to describe every
 * line of `text`, and describe it correctly.
 */
test("strip records what was removed", () => {
	const found = comments(
		".js",
		"/**\n * Formats the value.\n *\n *     code()\n */\n",
	);
	const c = found[0];
	const text = c.text.split("\n");
	const source = c.source.split("\n");

	expect(c.strip.length).toBeGreaterThanOrEqual(text.length - 1);

	// The invariant the alert adjustment depends on: blanking preserves width
	// and the dedent only takes a prefix, so a line of `text` plus what `strip`
	// says came off is the line of `source` it came from.
	//
	// The first and last lines are excluded because `delims` removed `/**` and
	// `*/` from them, which is a separate edit that `strip` does not describe.
	for (let i = 1; i < text.length - 1 && i < source.length - 1; i++) {
		const n = stripAt(c, i + 1);
		expect(n).not.toBeNull();
		expect(text[i].length + (n ?? 0)).toBe(source[i].length);
	}

	// Relative indentation has to survive, or an indented code block stops
	// being one. See #1028.
	expect(c.text).toContain("\n    code()");
});

describe("stripAt", () => {
	const c: Comment = {
		text: "",
		source: "",
		line: 1,
		offset: 0,
		scope: "",
		strip: [3, 4, 5],
		format: "",
		doc: "",
		masks: [],
	};

	test("a line it does not describe has no value", () => {
		for (const line of [0, -1, 4, 99]) expect(stripAt(c, line)).toBeNull();
	});

	test("a line it does describe", () => {
		expect(stripAt(c, 2)).toBe(4);
	});

	test("a comment with no strip reports none", () => {
		expect(stripAt({ ...c, strip: [] }, 1)).toBeNull();
	});
});

// --- the documentation conventions ------------------------------------------

/** Whether some mask holds exactly the first occurrence of `part` in `text`. */
function covers(masks: readonly Mask[], text: string, part: string): boolean {
	const at = text.indexOf(part);
	if (at < 0) return false;
	return masks.some(([from, to]) => from <= at && at + part.length <= to);
}

function checkMasks(
	masks: readonly Mask[],
	text: string,
	masked_: readonly string[],
	prose: readonly string[],
): void {
	for (const part of masked_) expect(covers(masks, text, part)).toBe(true);
	for (const part of prose) expect(covers(masks, text, part)).toBe(false);
}

test("Javadoc masks its tags", () => {
	const text =
		"Reads the record.\n\n<p>Call {@code foo(ctx)} before.\n@param name the identifier\n@throws IOError when it fails\n@return the payload\n";
	checkMasks(
		javadoc(text),
		text,
		["{@code foo(ctx)}", "@param name", "@throws IOError", "@return"],
		["the identifier", "when it fails", "the payload", "Reads"],
	);
});

test("JSDoc masks its tags and examples", () => {
	const text =
		"Reads the record.\n\n@example\nconst value = read(x);\n\n@param {string} name - The identifier.\n@param {object} [opts] - Options.\n@returns {Promise<object>} The payload.\n@see {@link other}\n@deprecated use read2.\n";
	checkMasks(
		jsDoc(text),
		text,
		[
			"@example",
			"const value = read(x);",
			"@param {string} name",
			"@param {object} [opts]",
			"@returns {Promise<object>}",
			"{@link other}",
			"@deprecated",
		],
		["The identifier", "Options", "The payload", "use read2", "Reads"],
	);
});

test("KDoc masks its links and tags", () => {
	const text =
		"See [foo] and [a.b] and [text][ref] and [link](url) for the details.\n@param name the identifier\n@return the payload\n";
	checkMasks(
		kDoc(text),
		text,
		["[foo]", "[a.b]", "[ref]", "@param name", "@return"],
		["[text]", "[link]", "the details", "the identifier", "the payload"],
	);
});

test("rustdoc masks its intra-doc links", () => {
	const text =
		"See [`Foo`] and [bar::baz] and [x](y) and [def]: url for the details.\n";
	checkMasks(
		rustDoc(text),
		text,
		["[`Foo`]", "[bar::baz]"],
		["[x]", "[def]", "the details"],
	);
});

test("a Go doc comment masks its links", () => {
	const text =
		"See [Name] and [pkg.Name] and [*T] for the details; [x]: is a definition.\n";
	checkMasks(
		goDoc(text),
		text,
		["[Name]", "[pkg.Name]", "[*T]"],
		["[x]", "the details"],
	);
});

test("a docstring masks its field names", () => {
	const text =
		"Reads the record.\n\n:param name: the identifier\n:raises ValueError: when it fails\n:returns: the payload\n:rtype: dict\n";
	checkMasks(
		pyDoc(text),
		text,
		[":param name:", ":raises ValueError:", ":returns:", ":rtype:"],
		["the identifier", "when it fails", "the payload", "Reads"],
	);
});

/**
 * A mask is tested by the line and column an alert carries: a 1-based line of
 * the comment's text and a 1-based column in code points.
 */
test("a mask is tested by line and column", () => {
	const c: Comment = {
		text: "ab\ncdé f",
		source: "",
		line: 1,
		offset: 0,
		scope: "",
		strip: [],
		format: "",
		doc: "",
		// `c`, `d` and `é` -- offsets 3, 4 and 5 of the text.
		masks: [[3, 6]],
	};

	const cases: Array<[number, number, boolean]> = [
		[1, 1, false],
		[1, 2, false],
		[2, 1, true],
		[2, 3, true],
		[2, 4, false],
		[2, 5, false],
		[3, 1, false],
	];
	for (const [line, col, want] of cases) {
		expect(masked(c, line, col)).toBe(want);
	}
});

/**
 * A Go doc comment opens with the name of what it documents, which is not
 * prose; a `//go:` line is a directive and is dropped outright.
 */
test("a Go comment masks the declared name", () => {
	const src =
		"//go:build linux\n\n// Package foo does x.\npackage foo\n\n// Bar reads.\n// More.\nfunc Bar() {}\n\n// Unrelated text.\n\ntype T struct {\n\t// Name is the name.\n\tName string\n}\n";
	const found = comments(".go", src);

	const got = found.map((c) => {
		for (const [from, to] of c.masks) {
			if (from === 0) return c.text.slice(0, to);
		}
		return "";
	});

	expect(got).toEqual(["Package foo", "Bar", "", "Name"]);
});
