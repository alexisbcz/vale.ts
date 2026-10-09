/**
 * Jupyter notebooks, read as the cells they hold.
 *
 * A notebook is JSON, so it could be read as data -- but its prose is not a
 * value a selector picks out: it is the `source` of every Markdown cell, and
 * of the code cells a `%%markdown` magic turns into prose. Each cell is also
 * linted in its own language, which a selector has no way to say.
 *
 * The current layout (nbformat 4) and the one before it (nbformat 3, with its
 * worksheets and heading cells) are both read. A cell's source may be one
 * string or a list of lines; either way the cell is one value, placed by each
 * of the scalars it was decoded from -- a list written one line per source
 * line still reports an alert on the right one.
 */

import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import {
	newPart,
	newSource,
	type Source,
	scalarAt,
	scalarText,
} from "./structured.ts";
import { strLen } from "./util.ts";
import type { Part, ScopedValue, ViewTarget } from "./view.ts";

/** One cell of a notebook. */
export interface Cell {
	/** `markdown`, `code`, or `raw`. */
	type: string;
	/**
	 * The extension of the code's language, such as `.py`, and empty for a
	 * language Vale has no grammar for.
	 */
	lang: string;
	value: ScopedValue;
}

/**
 * The extension Vale lints a kernel's language as.
 *
 * A language that is not here has no grammar, so its cells are skipped.
 */
export const KERNEL_EXTS: Readonly<Record<string, string>> = {
	python: ".py",
	python2: ".py",
	python3: ".py",
	ipython: ".py",
	r: ".r",
	julia: ".jl",
	javascript: ".js",
	typescript: ".ts",
	rust: ".rs",
	go: ".go",
	c: ".cpp",
	"c++": ".cpp",
	cpp: ".cpp",
	java: ".java",
	ruby: ".rb",
	lua: ".lua",
	php: ".php",
	haskell: ".hs",
	elixir: ".ex",
	clojure: ".clj",
	perl: ".r",
	csharp: ".cs",
	"c#": ".cs",
	scala: ".c",
	powershell: ".ps1",
};

/** Reads a `.ipynb` into its cells, in order. */
export function parseNotebook(f: ViewTarget): Cell[] {
	const doc = parseDocument(f.content);
	if (doc.errors.length > 0) {
		throw new Error(doc.errors[0]!.message);
	}
	const root = doc.contents;
	if (!isMap(root)) throw new Error("a notebook is a JSON object");

	const src = newSource(f.content);
	const lang = kernelLang(mapValue(root, "metadata"));

	let nodes: unknown[];
	const cells = mapValue(root, "cells");
	const sheets = mapValue(root, "worksheets");
	if (isSeq(cells)) {
		nodes = cells.items;
	} else if (isSeq(sheets)) {
		nodes = [];
		for (const sheet of sheets.items) {
			const sheetCells = mapValue(sheet, "cells");
			if (isSeq(sheetCells)) nodes.push(...sheetCells.items);
		}
	} else {
		throw new Error("a notebook has `cells` or `worksheets`");
	}

	const found: Cell[] = [];
	for (const node of nodes) {
		if (!isMap(node)) continue;
		const type = scalarValue(mapValue(node, "cell_type"));

		let source = mapValue(node, "source");
		// nbformat 3 keeps a code cell's source under `input`.
		if (type === "code" && source === null) source = mapValue(node, "input");
		if (source === null) continue;

		switch (type) {
			case "heading": {
				// nbformat 3 keeps a heading's level apart from its text; the
				// text is placed after the marks it would be written with.
				const level = scalarValue(mapValue(node, "level")) || "1";
				const depth = Math.max(
					1,
					Math.min(6, (level.codePointAt(0) ?? 0x31) - 0x30),
				);
				found.push({
					type: "markdown",
					lang: "",
					value: sourceValue(source, src, `${"#".repeat(depth)} `),
				});
				break;
			}
			case "code": {
				const cell: Cell = {
					type: "code",
					lang: cellLang(node, lang),
					value: sourceValue(source, src, ""),
				};
				const magic = cellMagic(cell.value.text);
				if (magic === "markdown" || magic === "md") {
					// The cell is prose; the magic line is blanked, not cut, so
					// the rest keeps its place.
					cell.type = "markdown";
					cell.value.text = blankFirstLine(cell.value.text);
				}
				found.push(cell);
				break;
			}
			case "markdown":
			case "raw":
				found.push({ type, lang: "", value: sourceValue(source, src, "") });
				break;
			default:
				break;
		}
	}

	return found;
}

/** The value under `key` in a mapping node, or null. */
function mapValue(node: unknown, key: string): unknown {
	if (!isMap(node)) return null;
	for (const item of node.items) {
		if (isScalar(item.key) && item.key.value === key) {
			return item.value ?? null;
		}
	}
	return null;
}

/** A scalar node's text, or "" for anything else. */
function scalarValue(node: unknown): string {
	return isScalar(node) ? scalarText(node) : "";
}

/** The extension of the notebook's kernel language. */
function kernelLang(meta: unknown): string {
	let name = scalarValue(mapValue(mapValue(meta, "kernelspec"), "language"));
	if (name === "") {
		name = scalarValue(mapValue(mapValue(meta, "language_info"), "name"));
	}
	// nbformat 3 keeps it at the top of the metadata.
	if (name === "") name = scalarValue(mapValue(meta, "language"));
	return KERNEL_EXTS[name.toLowerCase()] ?? "";
}

/**
 * The extension of a code cell's language: the cell's own, where an editor set
 * one, and the kernel's otherwise.
 */
function cellLang(cell: unknown, kernel: string): string {
	// nbformat 3 names it on the cell itself.
	let name = scalarValue(mapValue(cell, "language"));
	if (name === "") {
		name = scalarValue(
			mapValue(mapValue(mapValue(cell, "metadata"), "vscode"), "languageId"),
		);
	}
	return KERNEL_EXTS[name.toLowerCase()] ?? kernel;
}

/** The name of the cell magic a code cell starts with, or null. */
function cellMagic(text: string): string | null {
	const first = (text.split("\n", 1)[0] ?? "").trim();
	if (!first.startsWith("%%")) return null;
	return first.slice(2).split(" ", 1)[0] ?? "";
}

/** Replaces a text's first line with spaces of the same width. */
function blankFirstLine(text: string): string {
	const nl = text.indexOf("\n");
	const first = nl < 0 ? text : text.slice(0, nl);
	const blank = " ".repeat(strLen(first));
	// `text.slice(nl)` still carries the newline, so only the line before it
	// is replaced.
	return nl < 0 ? blank : blank + text.slice(nl);
}

/**
 * Joins a cell's source, one string or a list of them, into one value placed
 * by each of its scalars.
 *
 * A prefix is text the file does not hold, so the value's parts start after
 * it: an offset inside the prefix maps to the first scalar, which is where the
 * cell begins.
 */
function sourceValue(source: unknown, src: Source, prefix: string): ScopedValue {
	let nodes: unknown[] = [];
	if (isScalar(source)) nodes = [source];
	else if (isSeq(source)) nodes = source.items;

	const parts: Part[] = [];
	let text = prefix;
	let offset = strLen(prefix);
	let line = 0;
	let column = 0;

	for (const node of nodes) {
		if (!isScalar(node)) continue;
		const sp = scalarAt(node, src);
		if (parts.length === 0) {
			line = sp.line;
			column = sp.column;
		}
		parts.push(newPart(src.lines, sp, offset));
		const value = scalarText(node);
		text += value;
		offset += strLen(value);
	}

	const sv: ScopedValue = { text, line, column, parts };
	if (isSeq(source)) sv.joined = true;
	return sv;
}

/** Describes a cell, for test output. */
export function describeCell(c: Cell): string {
	return `${c.type}${c.lang}@${c.value.line}:${c.value.column} ${JSON.stringify(c.value.text)}`;
}
