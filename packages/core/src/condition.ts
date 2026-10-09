/**
 * A section header's `if`.
 *
 * `[*.md if .Meta.draft]` applies to the Markdown files whose front matter
 * says they are drafts. The glob and the condition are separate concerns: the
 * glob decides which files the section could apply to, the condition decides
 * which of those it does apply to.
 */

import { compileExpr, type Expression } from "./expr.ts";
import { parseFrontMatter } from "./frontmatter.ts";
import { baseName, dirName, extName, toSlash } from "./util.ts";

/**
 * What splits a section header into its glob and its condition.
 *
 * Spelled with the spaces, the way a list comprehension's `if` filters its
 * source, so that a glob holding the letters `if` is not mistaken for one.
 */
const COND_SEP = " if ";

/** A section header's glob and its condition, which is "" for a plain one. */
export function splitSection(label: string): [string, string] {
	const i = label.indexOf(COND_SEP);
	if (i >= 0) {
		return [label.slice(0, i).trim(), label.slice(i + COND_SEP.length).trim()];
	}
	return [label, ""];
}

/**
 * What a condition reads about a file.
 *
 * Shaped the way `--filter` reads a rule -- capitalized, addressed with a
 * leading dot -- so that the two are written the same way.
 */
export interface FileFields {
	/** Relative to the root `.vale.ini`, with forward slashes. */
	Path: string;
	Dir: string;
	Name: string;
	Ext: string;
	/** The front matter, keyed as written. */
	Meta: Record<string, unknown>;
}

/** A compiled `if` expression. */
export class Condition {
	readonly source: string;
	/** Whether the expression reads front matter, which most do not. */
	readonly readsMeta: boolean;

	private readonly program: Expression;

	constructor(source: string) {
		this.source = source;
		// Go compiles `any(Files, {<source>})` with `expr.AsBool()`: the
		// condition is written as a predicate over one file, and an expression
		// that cannot be a boolean is refused here rather than silently read as
		// true for every file.
		this.program = compileExpr(source, { asBool: true });
		this.readsMeta = source.includes(".Meta");
	}

	/** Whether the condition is true for the given file. */
	holds(f: FileFields): boolean {
		// The fields are the item under consideration, which is what a leading
		// dot addresses -- the same shape as Vale's `any(Files, {...})`, where
		// the predicate's `#` is the one file in `Files`.
		return this.program.runBool({ Files: [f], ...asEnv(f) }, f);
	}
}

/** The fields, also exposed by name so `Path` works as well as `.Path`. */
function asEnv(f: FileFields): Record<string, unknown> {
	return { Path: f.Path, Dir: f.Dir, Name: f.Name, Ext: f.Ext, Meta: f.Meta };
}

/**
 * Describes the file at `path`.
 *
 * Front matter is parsed only when `meta` is set, since most conditions never
 * read it and parsing it per file is not free.
 */
export function newFileFields(
	path: string,
	content: string,
	meta: boolean,
	rootINI: string,
): FileFields {
	const rel = toSlash(relToRoot(path, rootINI));
	const fields: FileFields = {
		Path: rel,
		Dir: toSlash(dirName(rel)),
		Name: baseName(path),
		Ext: extName(path),
		Meta: {},
	};

	if (meta) {
		const fm = parseFrontMatter(content);
		if (fm !== null) fields.Meta = fm.data;
	}

	return fields;
}

/** `path` relative to the directory holding the root `.vale.ini`. */
export function relToRoot(path: string, rootINI: string): string {
	if (rootINI === "") return path;
	const root = toSlash(dirName(rootINI));
	const abs = toSlash(path.startsWith("/") ? path : `${process.cwd()}/${path}`);
	if (!abs.startsWith(`${root}/`)) return path;
	return abs.slice(root.length + 1);
}
