/**
 * Reading a Jupyter notebook, cell by cell.
 *
 * Ported from `internal/lint/notebook.go`. The cells are parsed in
 * `@vale-ts/core`, which has its own tests; what is here is the reader's part:
 * which cells are read, as what, and where their alerts land.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { File } from "@vale-ts/core";
import { newAlert, newConfig, newFile, newFlags, ValeError } from "@vale-ts/core";
import { initCode } from "../src/code/index.ts";
import { lintNotebook, type NotebookHost } from "../src/notebook.ts";

beforeAll(async () => {
	await initCode();
});

const cfg = newConfig(newFlags({ ignoreGlobal: true }));

/** A host that records what it was asked to read, and as what. */
function host(): NotebookHost & { read: Array<[string, string]> } {
	return {
		read: [],
		readAs(f, format) {
			this.read.push([format, f.content]);
		},
		readAsCode(f, ext) {
			this.read.push([ext, f.content]);
		},
	};
}

function notebook(cells: unknown[], language = "python"): File {
	const f = newFile(
		JSON.stringify({
			cells,
			metadata: { kernelspec: { language } },
			nbformat: 4,
			nbformat_minor: 5,
		}),
		cfg,
	);
	f.realExt = ".ipynb";
	f.normedExt = ".ipynb";
	f.path = "demo.ipynb";
	return f;
}

describe("which cells are read", () => {
	test("a Markdown cell is read as Markdown", () => {
		const h = host();
		lintNotebook(
			h,
			notebook([{ cell_type: "markdown", source: "# A heading\n", metadata: {} }]),
		);
		expect(h.read).toEqual([["md", "# A heading\n"]]);
	});

	test("a code cell is read as the kernel's language", () => {
		const h = host();
		lintNotebook(
			h,
			notebook([{ cell_type: "code", source: "# A note.\n", metadata: {} }]),
		);
		expect(h.read).toEqual([[".py", "# A note.\n"]]);
	});

	test("a raw cell is neither", () => {
		const h = host();
		lintNotebook(
			h,
			notebook([
				{ cell_type: "raw", source: "Not prose, not code.\n", metadata: {} },
			]),
		);
		expect(h.read).toHaveLength(0);
	});

	test("a code cell in a language Vale has no grammar for is skipped", () => {
		const h = host();
		lintNotebook(
			h,
			notebook([{ cell_type: "code", source: "x <- 1\n", metadata: {} }], "nim"),
		);
		expect(h.read).toHaveLength(0);
	});

	test("the file is itself again afterwards", () => {
		const h = host();
		const f = notebook([
			{ cell_type: "markdown", source: "# A heading\n", metadata: {} },
		]);
		const before = f.content;
		lintNotebook(h, f);
		expect(f.content).toBe(before);
		expect(f.normedExt).toBe(".ipynb");
	});
});

describe("where a cell's alerts land", () => {
	test("an alert is placed where the cell's source sits in the file", () => {
		const source =
			'{\n "cells": [\n  {\n   "cell_type": "markdown",\n   "source": "A misteak here.\\n",\n   "metadata": {}\n  }\n ],\n "metadata": {"kernelspec": {"language": "python"}},\n "nbformat": 4,\n "nbformat_minor": 5\n}\n';
		const f = newFile(source, cfg);
		f.realExt = ".ipynb";
		f.normedExt = ".ipynb";
		f.path = "demo.ipynb";

		const h: NotebookHost = {
			readAs(file) {
				// An alert on the cell's own first line, at the word.
				const a = newAlert();
				a.line = 1;
				const at = file.content.indexOf("misteak") + 1;
				a.span = [at, at + "misteak".length - 1];
				file.alerts.push(a);
			},
			readAsCode: () => {},
		};

		lintNotebook(h, f);

		expect(f.alerts).toHaveLength(1);
		// The cell's source is on line 5 of the notebook, and the word sits
		// where the scalar holds it.
		expect(f.alerts[0].line).toBe(5);
		expect(source.split("\n")[4].slice(f.alerts[0].span[0] - 1)).toStartWith(
			"misteak",
		);
	});
});

describe("a notebook that is not a notebook", () => {
	test("a truncated file is an error naming it", () => {
		const f = newFile('{\n "cells": [\n', cfg);
		f.realExt = ".ipynb";
		f.normedExt = ".ipynb";
		f.path = "broken.ipynb";

		// The file is the error's context, which is how it reaches the report
		// as `[broken.ipynb]:E100:...`.
		let caught: unknown;
		try {
			lintNotebook(host(), f);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ValeError);
		expect((caught as ValeError).context).toBe("broken.ipynb");
		expect((caught as Error).message).toContain("yaml: line 2:");
	});

	test("a JSON scalar is not a notebook", () => {
		const f = newFile('"just a string"', cfg);
		f.realExt = ".ipynb";
		f.normedExt = ".ipynb";
		f.path = "demo.ipynb";

		expect(() => lintNotebook(host(), f)).toThrow();
	});
});
