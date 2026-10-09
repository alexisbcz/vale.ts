/**
 * Putting a comment's alerts back where they came from.
 *
 * Ported from the arithmetic in `internal/lint/fragment.go`. An alert is
 * reported against the comment's extracted text, where the delimiters, the
 * decoration and the base indentation are gone; its position in the source is
 * that plus what the extraction removed.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { Alert } from "@vale-ts/core";
import { newAlert } from "@vale-ts/core";
import {
	type Comment,
	getComments,
	getLanguageFromExt,
	initCode,
} from "../src/code/index.ts";
import { adjustAlerts, commentPadding } from "../src/fragment.ts";
import { findLine, leadingSpaces } from "../src/util.ts";

beforeAll(async () => {
	await initCode();
});

/** An alert reported at `line` and `column` of a comment's text. */
function at(line: number, column: number): Alert {
	const a = newAlert();
	a.line = line;
	a.span = [column, column];
	return a;
}

/** Where `word` sits in the source, after one comment's alerts are moved. */
function place(ext: string, src: string, word: string): Array<[number, number]> {
	const lang = getLanguageFromExt(ext);
	const found = getComments(src, lang);
	const out: Array<[number, number]> = [];

	for (const c of found) {
		const lines = c.text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const col = lines[i].indexOf(word);
			if (col < 0) continue;
			const alerts = [at(i + 1, col + 1)];
			adjustAlerts(alerts, 0, c, lang);
			out.push([alerts[0].line, alerts[0].span[0]]);
		}
	}
	return out;
}

/** Where `word` actually sits in the source, 1-based. */
function actual(src: string, word: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	const lines = src.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const col = lines[i].indexOf(word);
		if (col >= 0) out.push([i + 1, col + 1]);
	}
	return out;
}

describe("an alert lands where the word is", () => {
	const cases: Array<[string, string, string, string]> = [
		[
			"a Go line comment",
			".go",
			"package main\n\n// The wordhere matters.\nfunc main() {}\n",
			"wordhere",
		],
		[
			"a run of line comments",
			".go",
			"package main\n\n// One line.\n// The wordhere matters.\nfunc main() {}\n",
			"wordhere",
		],
		[
			"an indented line comment",
			".go",
			"package main\n\nfunc main() {\n\t// The wordhere matters.\n}\n",
			"wordhere",
		],
		[
			"a comment after code on the same line",
			".go",
			"package main\n\nvar x = 1 // The wordhere matters.\n",
			"wordhere",
		],
		[
			"a JSDoc block, whose decoration is not whitespace",
			".js",
			"/**\n * The wordhere matters.\n */\nfunction f() {}\n",
			"wordhere",
		],
		[
			"an indented JSDoc block",
			".js",
			"class C {\n  /**\n   * The wordhere matters.\n   */\n  f() {}\n}\n",
			"wordhere",
		],
		[
			"a Python docstring",
			".py",
			'def f():\n    """The wordhere matters.\n\n    And more.\n    """\n',
			"wordhere",
		],
		[
			"a line of a Python docstring under its opener",
			".py",
			'def f():\n    """Summary.\n\n    The wordhere matters.\n    """\n',
			"wordhere",
		],
		[
			"a Python comment after code",
			".py",
			"x = 1  # The wordhere matters.\n",
			"wordhere",
		],
		[
			"a C block comment",
			".c",
			"/* The wordhere matters. */\nint main(void) { return 0; }\n",
			"wordhere",
		],
		[
			"a YAML comment, read by the scanner",
			".yml",
			"key: value  # The wordhere matters.\n",
			"wordhere",
		],
		[
			"an indented YAML comment",
			".yml",
			"a:\n  # The wordhere matters.\n  b: 1\n",
			"wordhere",
		],
	];

	for (const [name, ext, src, word] of cases) {
		test(name, () => {
			expect(place(ext, src, word)).toEqual(actual(src, word));
		});
	}
});

describe("commentPadding", () => {
	/**
	 * A dedented comment recorded what it took off each line, so it is asked
	 * rather than measured. Measuring agrees with the dedent only when
	 * everything removed was whitespace.
	 */
	test("a dedented comment is asked, not measured", () => {
		const lang = getLanguageFromExt(".js");
		const [c] = getComments(
			"/**\n * The word matters.\n */\nfunction f() {}\n",
			lang,
		);
		// Line 2 of the text is `The word matters.`; the source line is
		// ` * The word matters.`, so three characters came off.
		expect(commentPadding(c, 2, findLine(c.source, 2), lang)).toBe(3);
	});

	test("a comment with no strip is measured from its source line", () => {
		const lang = getLanguageFromExt(".go");
		const c: Comment = {
			text: "A note.",
			// A comment's source begins at its delimiter, not at the margin:
			// the indentation before it is the comment's own offset.
			source: "// A note.",
			line: 1,
			offset: 3,
			scope: "text.comment.line",
			strip: [],
			format: "",
			doc: "",
			masks: [],
		};
		// `//` plus the space after it.
		expect(commentPadding(c, 1, c.source, lang)).toBe(3);
	});
});

describe("leadingSpaces", () => {
	test("counts the spaces a line begins with, less the offset", () => {
		expect(leadingSpaces("    text", 0)).toBe(4);
		expect(leadingSpaces("    text", 2)).toBe(2);
		expect(leadingSpaces("text", 0)).toBe(0);
	});
});
