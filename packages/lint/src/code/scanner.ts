/**
 * Finding comments without a grammar.
 *
 * Clojure, PowerShell, Haskell, Julia and Protocol Buffers have no usable
 * tree-sitter grammar in this build (see `lang.ts`), so their comments are
 * found by their delimiters: a line comment runs from its marker to the end of
 * the line, and a block comment from its opener to the first closer.
 *
 * That is all this does differently. The text is handed to the same
 * `CommentBuilder` a captured node goes through, so a comment found here is
 * dedented, scoped and placed exactly as one found by a query -- and the
 * markup a view maps onto the file works the same way.
 *
 * What a delimiter cannot know is context, so the one piece of context that
 * matters is tracked: a double-quoted string. Without it the `/*` in a
 * Protocol Buffers option -- `get: "/v1/{name=bars/*}"` -- opened a comment
 * that swallowed the next six lines. YAML needs more than that, and has a
 * reader of its own below.
 */

import { CommentBuilder } from "./query.ts";
import type { Comment, Language } from "./types.ts";

/** The comments of `source`, found by `lang`'s delimiters. */
export function scanComments(source: string, lang: Language): Comment[] {
	const delims = lang.scanner;
	if (delims === null) return [];
	if (delims.style === "yaml") return scanYAML(source, lang);

	const builder = new CommentBuilder(lang);
	const found: Comment[] = [];
	const lines = source.split("\n");

	let block: string[] | null = null;
	let blockRow = 0;
	let blockCol = 0;

	const emit = (text: string, row: number, col: number): void => {
		found.push(builder.build(text, row, col, "", lang.queries[0]?.type ?? "", ""));
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (block !== null) {
			const end = matchOf(delims.blockEnd, line);
			if (end === null) {
				block.push(line);
				continue;
			}
			block.push(line.slice(0, end.index + end[0].length));
			emit(block.join("\n"), blockRow, blockCol);
			block = null;
			continue;
		}

		const strings = stringSpans(line);
		const start = matchOf(delims.blockStart, line, strings);
		const inline = matchOf(delims.inline, line, strings);

		// Whichever opens first on the line wins: `# a note` is a line comment
		// even in a language whose block opener also begins with `#`.
		if (start !== null && (inline === null || start.index <= inline.index)) {
			const after = line.slice(start.index + start[0].length);
			const end = matchOf(delims.blockEnd, after);
			if (end !== null) {
				// Opened and closed on one line.
				const stop =
					start.index + start[0].length + end.index + end[0].length;
				emit(line.slice(start.index, stop), i, start.index);
				continue;
			}
			block = [line.slice(start.index)];
			blockRow = i;
			blockCol = start.index;
			continue;
		}

		if (inline !== null) {
			emit(inline[0], i, inline.index);
		}
	}

	// A block comment the file never closes still holds prose; reading it to
	// the end of the file is what a reader does.
	if (block !== null) emit(block.join("\n"), blockRow, blockCol);

	return found;
}

/**
 * The first non-empty match of `re` in `line` outside a string literal, or
 * null.
 *
 * A language with no block comments names `$^` as its delimiters, which no
 * line can hold -- except an empty one, where the start and the end of the
 * line are the same position and the pattern matches "". Requiring a match to
 * have a width is what keeps every blank line from opening a comment, and is
 * what Go's `len(match) > 0` does.
 */
function matchOf(
	re: RegExp,
	line: string,
	strings: ReadonlyArray<[number, number]> = [],
): RegExpExecArray | null {
	const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
	for (let m = all.exec(line); m !== null; m = all.exec(line)) {
		if (m[0].length === 0) {
			all.lastIndex++;
			continue;
		}
		if (!strings.some(([from, to]) => m.index >= from && m.index < to)) return m;
	}
	return null;
}

/**
 * The ranges of `line` held by a double-quoted string.
 *
 * Double quotes alone: a single quote is a character literal in C, a quote
 * form in Clojure and an apostrophe in prose, and pairing those does more harm
 * than leaving them. An unterminated quote runs to the end of the line, which
 * is what a line-oriented reader has to assume.
 */
function stringSpans(line: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let open = -1;

	for (let i = 0; i < line.length; i++) {
		if (open >= 0) {
			if (line[i] === "\\") i++;
			else if (line[i] === '"') {
				spans.push([open, i + 1]);
				open = -1;
			}
			continue;
		}
		if (line[i] === '"') open = i;
	}

	if (open >= 0) spans.push([open, line.length]);
	return spans;
}

/**
 * The comments of a YAML file.
 *
 * A `#` is a comment only where YAML says it is: at the start of a line, or
 * after whitespace, and not inside a quoted scalar or the body of a block
 * scalar. A pattern cannot know that, which is exactly what the grammar was
 * for -- so the rule is written out here instead.
 *
 * Both quotings are tracked, with their own escapes: `\` in a double-quoted
 * scalar and a doubled `''` in a single-quoted one. A block scalar's body is
 * every following line indented past its opener, blank lines included.
 */
function scanYAML(source: string, lang: Language): Comment[] {
	const builder = new CommentBuilder(lang);
	const found: Comment[] = [];
	const lines = source.split("\n");

	// The indentation a line must have to be inside the open block scalar, or
	// -1 when there is none.
	let blockIndent = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (blockIndent >= 0) {
			// A blank line stays inside the block; a line indented less than the
			// body ends it, and is then read as an ordinary line.
			if (line.trim() === "") continue;
			if (indentOf(line) >= blockIndent) continue;
			blockIndent = -1;
		}

		const marker = yamlCommentAt(line);
		if (marker >= 0) {
			found.push(
				builder.build(
					line.slice(marker),
					i,
					marker,
					"",
					lang.queries[0]?.type ?? "",
					"",
				),
			);
		}

		// A block scalar opens on a line whose value is `|` or `>`, with the
		// chomping and indentation indicators YAML allows after it.
		const value = marker < 0 ? line : line.slice(0, marker);
		if (RE_BLOCK_SCALAR.test(value)) blockIndent = indentOf(line) + 1;
	}

	return found;
}

/** A block scalar's header, at the end of the line that opens it. */
const RE_BLOCK_SCALAR = /(?:^|[\s])[|>][0-9]*[-+]?[ \t]*$/;

/** How many columns of indentation a line begins with. */
function indentOf(line: string): number {
	let n = 0;
	while (n < line.length && (line[n] === " " || line[n] === "\t")) n++;
	return n;
}

/**
 * The index of the `#` that opens a comment on a YAML line, or -1.
 *
 * The marker has to start the line or follow whitespace -- `a#b` is a scalar
 * holding a hash -- and it has to be outside both quotings.
 */
function yamlCommentAt(line: string): number {
	let quote = "";

	for (let i = 0; i < line.length; i++) {
		const c = line[i];

		if (quote === '"') {
			if (c === "\\") i++;
			else if (c === '"') quote = "";
			continue;
		}
		if (quote === "'") {
			// A doubled quote is an escaped one, not the end of the scalar.
			if (c === "'") {
				if (line[i + 1] === "'") i++;
				else quote = "";
			}
			continue;
		}

		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c !== "#") continue;
		if (i === 0 || line[i - 1] === " " || line[i - 1] === "\t") return i;
	}

	return -1;
}
