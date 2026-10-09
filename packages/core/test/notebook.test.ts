/** Ports of `internal/core/notebook_test.go`. */

import { describe, expect, test } from "bun:test";
import { type Cell, describeCell, parseNotebook } from "../src/notebook.ts";
import { locateInValue } from "../src/view.ts";

function cells(src: string): Cell[] {
	return parseNotebook({ content: src, realExt: ".ipynb" });
}

// A cell's source may be a list or a string; a code cell takes the kernel's
// language; raw cells are kept, to be skipped by the caller.
test("a notebook's cells, in order", () => {
	const got = cells(`{
 "cells": [
  {"cell_type": "markdown", "metadata": {}, "source": ["# Title\\n", "\\n", "Split\\n", "across lines."]},
  {"cell_type": "code", "metadata": {}, "outputs": [], "source": ["# a comment\\n", "print(1)"]},
  {"cell_type": "raw", "metadata": {}, "source": "raw text"},
  {"cell_type": "markdown", "metadata": {}, "source": "One string."}
 ],
 "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}},
 "nbformat": 4, "nbformat_minor": 5
}`);

	expect(got.map(describeCell)).toEqual([
		'markdown@3:57 "# Title\\n\\nSplit\\nacross lines."',
		'code.py@4:68 "# a comment\\nprint(1)"',
		'raw@5:51 "raw text"',
		'markdown@6:56 "One string."',
	]);
	// One part per element, so each line of the cell is placed on its own.
	expect(got[0]!.value.parts).toHaveLength(4);
	expect(got[0]!.value.joined).toBe(true);
	expect(got[3]!.value.joined).toBeUndefined();
});

// The kernel's language comes from the kernelspec, then language_info; a cell
// may name its own; and a language with no grammar leaves it empty.
describe("a code cell's language", () => {
	const cases: Array<[string, string, string, string]> = [
		["kernelspec", '"kernelspec": {"language": "R"}', "", ".r"],
		["language_info", '"language_info": {"name": "julia"}', "", ".jl"],
		[
			"kernelspec wins",
			'"kernelspec": {"language": "python"}, "language_info": {"name": "R"}',
			"",
			".py",
		],
		[
			"cell override",
			'"kernelspec": {"language": "python"}',
			'"metadata": {"vscode": {"languageId": "javascript"}}',
			".js",
		],
		["no grammar", '"kernelspec": {"language": "bash"}', "", ""],
		["no metadata", "", "", ""],
	];

	for (const [name, meta, cell, want] of cases) {
		test(name, () => {
			const cellMeta = cell === "" ? '"metadata": {}' : cell;
			const got = cells(
				`{"cells": [{"cell_type": "code", ${cellMeta}, "source": ["x = 1"]}], "metadata": {${meta}}, "nbformat": 4}`,
			);
			expect(got).toHaveLength(1);
			expect(got[0]!.lang).toBe(want);
		});
	}
});

// A `%%markdown` cell is prose. Its magic line is blanked, not removed, so the
// rest of the cell keeps its place.
test("a %%markdown magic makes a code cell prose", () => {
	const got = cells(`{"cells": [
  {"cell_type": "code", "metadata": {}, "source": ["%%markdown\\n", "# A heading\\n", "Prose."]},
  {"cell_type": "code", "metadata": {}, "source": ["%%bash\\n", "# a comment"]}
 ], "metadata": {"kernelspec": {"language": "python"}}, "nbformat": 4}`);

	expect(got).toHaveLength(2);
	expect(got[0]!.type).toBe("markdown");
	expect(got[0]!.value.text).toBe("          \n# A heading\nProse.");
	expect(locateInValue(got[0]!.value, got[0]!.value.text.indexOf("Prose"))).toEqual(
		[2, 86],
	);

	// Any other magic leaves the cell as code, in the kernel's language.
	expect(got[1]!.type).toBe("code");
	expect(got[1]!.lang).toBe(".py");
});

// nbformat 3: cells live in worksheets, a heading is its own kind with a
// level, code is under `input`, and a cell names its language.
test("nbformat 3", () => {
	const got = cells(`{
 "worksheets": [{"cells": [
  {"cell_type": "heading", "level": 2, "source": ["A heading"]},
  {"cell_type": "code", "language": "python", "input": ["# comment\\n", "x = 1"], "outputs": []},
  {"cell_type": "markdown", "source": ["Prose."]}
 ]}],
 "metadata": {"name": "old"},
 "nbformat": 3, "nbformat_minor": 0
}`);

	expect(got.map(describeCell)).toEqual([
		'markdown@3:52 "## A heading"',
		'code.py@4:58 "# comment\\nx = 1"',
		'markdown@5:41 "Prose."',
	]);

	// The heading's marks are not in the file: the text after them is.
	expect(locateInValue(got[0]!.value, 3)).toEqual([3, 52]);
	expect(locateInValue(got[0]!.value, 0)).toEqual([3, 52]);
});

test("a notebook that cannot be read", () => {
	for (const src of ['{"cells": [', "[1, 2]", '{"nbformat": 4}']) {
		expect(() => cells(src)).toThrow();
	}
});

test("a cell with no source, and a kind that is not a cell, are skipped", () => {
	const got = cells(
		'{"cells": [{"cell_type": "markdown"}, {"cell_type": "display_data", "source": "x"}, {"cell_type": "raw", "source": "kept"}], "nbformat": 4}',
	);
	expect(got.map((c) => c.value.text)).toEqual(["kept"]);
});

test("a heading's level sets how many marks the text follows", () => {
	const marks = (level: string): string => {
		const got = cells(
			`{"worksheets": [{"cells": [{"cell_type": "heading", ${level}"source": ["T"]}]}], "nbformat": 3}`,
		);
		return got[0]!.value.text;
	};
	expect(marks('"level": 1, ')).toBe("# T");
	expect(marks('"level": 4, ')).toBe("#### T");
	// Out of range, and absent, both fall inside 1..6.
	expect(marks('"level": 9, ')).toBe("###### T");
	expect(marks("")).toBe("# T");
});
