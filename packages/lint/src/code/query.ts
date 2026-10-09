/**
 * Turning a captured node into a comment.
 *
 * The queries say which nodes hold prose; this is what happens to one once it
 * is found. The delimiters come off the edges, the per-line decoration is
 * blanked, and the body is dedented -- each step recording what it removed, so
 * an alert reported against the result can be put back exactly where it came
 * from.
 */

import type { Node, Query, Tree } from "web-tree-sitter";
import type { Comment, Language } from "./types.ts";

/**
 * The indentation a comment is dedented by when its language does not name its
 * own.
 *
 * Tabs belong here alongside spaces: a block comment indented with tabs that
 * keeps them reads as an indented code block in Markdown, so its body is never
 * linted. See #1130.
 */
const DEFAULT_CUTSET = " \t";

/** Builds comments from raw text, the way one language spells them. */
export class CommentBuilder {
	protected readonly lang: Language;
	protected readonly cutset: string;

	constructor(lang: Language) {
		this.lang = lang;
		this.cutset = lang.cutset === "" ? DEFAULT_CUTSET : lang.cutset;
	}

	/**
	 * One comment, from its text as written.
	 *
	 * `meta` is the query's name, which becomes part of the scope; `prose` says
	 * the text is bare content -- Elixir's `quoted_content`, the body of a
	 * string -- and holds no decoration at all, so nothing may be taken off it.
	 */
	build(
		rTextArg: string,
		rowArg: number,
		offsetArg: number,
		meta: string,
		format: string,
		doc: string,
		prose = false,
	): Comment {
		let rText = rTextArg;
		let row = rowArg;
		let offset = offsetArg;

		// Some grammars' comment tokens swallow the whitespace -- newlines
		// included -- that precedes them; shift the node past it so the line and
		// the offset point at the delimiter.
		const trimmed = rText.replace(/^[ \t\n]+/, "");
		const cut = rText.length - trimmed.length;
		if (cut > 0) {
			const pre = rText.slice(0, cut);
			const breaks = countNewlines(pre);
			if (breaks > 0) {
				row += breaks;
				offset = cut - (pre.lastIndexOf("\n") + 1);
			} else {
				offset += cut;
			}
			rText = trimmed;
		}

		let cText = prose ? rText : this.stripDelims(rText);
		let strip: number[] = [];

		const suffix = meta === "" ? "" : `.${meta}`;
		let scope = `text.comment${suffix}.line`;

		// A trailing newline is part of some grammars' tokens; only a newline
		// between content makes a comment a block.
		if (countNewlines(cText.replace(/\n+$/, "")) > 0) {
			scope = `text.comment${suffix}.block`;

			// Blank the per-line decoration before measuring indentation, so
			// ` * text` is dedented as three spaces rather than read as a
			// Markdown list item. Blanking keeps the width, so nothing has moved
			// yet; the dedent below takes it off and records how much.
			if (!prose) cText = this.blankPrefixes(cText);

			// Dedent like Python's `inspect.cleandoc`: the first line sits on
			// (or just after) the opening delimiter, so its leading whitespace
			// is incidental and is trimmed fully; the remaining lines are
			// dedented only by the indentation common to them. This removes a
			// comment's base indentation while preserving relative indentation,
			// which is significant for markup such as reStructuredText literal
			// blocks and Markdown indented code. See #1028.
			const lines = cText.split("\n");
			const common = commonIndent(lines.slice(1), this.cutset);

			let buf = "";
			strip = new Array<number>(lines.length);
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const out =
					i === 0
						? trimLeftSet(line, this.cutset)
						: stripIndent(line, common, this.cutset);

				// What came off this line, so an alert reported against it can be
				// put back exactly. Re-deriving this downstream from the source
				// line is what makes a non-whitespace cutset report the wrong
				// column.
				strip[i] = line.length - out.length;

				buf += `${out}\n`;
			}

			cText = buf;
		}

		return {
			line: row + 1,
			offset,
			scope,
			text: cText,
			source: rText,
			strip,
			format,
			doc,
			masks: [],
		};
	}

	/**
	 * Takes a comment's delimiters off its edges: the marker or opener at the
	 * very start -- repeated, so a `##` banner comes off whole -- and one closer
	 * against the end, trailing whitespace aside.
	 *
	 * Only the edges: a delimiter character inside the prose -- the `#` of a
	 * Markdown heading, the `//` of a URL -- is content, and stripping it
	 * shifted every alert to its right by its width. Per-line decoration inside
	 * a block is `blankPrefixes`'s job.
	 */
	stripDelims(sArg: string): string {
		let s = sArg;
		const delims = new RegExp(this.lang.delims.source, "g");

		// The opener, repeated so a doubled marker comes off whole.
		for (;;) {
			delims.lastIndex = 0;
			const m = delims.exec(s);
			if (m === null || m.index !== 0 || m[0].length === 0) break;
			s = s.slice(m[0].length);
		}

		// The closer: one match running to the end, trailing whitespace aside.
		const body = s.replace(/[ \t\n]+$/, "");
		const tail = s.slice(body.length);
		delims.lastIndex = 0;
		let last: RegExpExecArray | null = null;
		for (;;) {
			const m = delims.exec(body);
			if (m === null) break;
			last = m;
			if (m[0].length === 0) delims.lastIndex++;
		}
		if (last !== null && last.index + last[0].length === body.length) {
			s = body.slice(0, last.index) + tail;
		}
		return s;
	}

	/**
	 * Replaces each line's comment decoration with spaces.
	 *
	 * The width is deliberately unchanged: blanking moves nothing, so the dedent
	 * that follows is the only step that has to account for a column, and a
	 * language without decoration behaves exactly as it did before.
	 */
	blankPrefixes(s: string): string {
		const prefix = this.lang.prefix;
		if (prefix === null) return s;

		const lines = s.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const m = prefix.exec(lines[i]);
			if (m === null) continue;

			// Group 1 is the decoration itself. The pattern looks past it to
			// decide whether it is decoration at all -- `*` followed by a space
			// starts a line, `*` followed by a letter starts emphasis -- but only
			// the group is blanked, so the character that settled the question is
			// left where it was.
			let lo = m.index;
			let hi = m.index + m[0].length;
			if (m[1] !== undefined) {
				lo = m.index;
				hi = m.index + m[1].length;
			}

			lines[i] = lines[i].slice(0, lo) + " ".repeat(hi - lo) + lines[i].slice(hi);
		}

		return lines.join("\n");
	}
}

/** Runs a language's queries over a parsed tree. */
export class QueryEngine extends CommentBuilder {
	private readonly tree: Tree;

	constructor(tree: Tree, lang: Language) {
		super(lang);
		this.tree = tree;
	}

	run(meta: string, format: string, query: Query): Comment[] {
		const comments: Comment[] = [];

		for (const match of query.matches(this.tree.rootNode)) {
			for (const capture of match.captures) {
				// A capture named with a leading underscore exists for a predicate
				// to test, not to be linted -- the convention tree-sitter itself
				// uses for internal captures. Without this, the only way to test
				// one node and extract another is to test the node you extract,
				// which forces a query to capture more than the prose it wants.
				if (capture.name.startsWith("_")) continue;

				// A capture named `prose` is bare content and carries no
				// delimiters; everything else -- `comment`, `docstring` -- does.
				const prose = capture.name === "prose";
				const node: Node = capture.node;

				comments.push(
					this.build(
						node.text,
						node.startPosition.row,
						node.startPosition.column,
						meta,
						format,
						this.lang.docName?.(node) ?? "",
						prose,
					),
				);
			}
		}

		return comments;
	}
}

/**
 * The length of the longest run of leading `cutset` characters shared by every
 * non-blank line.
 *
 * Blank lines -- those that are empty after trimming -- are ignored so they do
 * not force the indent to zero.
 */
export function commonIndent(lines: readonly string[], cutset: string): number {
	let common = -1;
	for (const line of lines) {
		const rest = trimLeftSet(line, cutset);
		if (rest === "") continue;
		const n = line.length - rest.length;
		if (common === -1 || n < common) common = n;
	}
	return common < 0 ? 0 : common;
}

/**
 * Removes up to `n` leading `cutset` characters from `line`.
 *
 * A line with fewer than `n` -- a blank line, say -- loses only what it has.
 */
export function stripIndent(line: string, n: number, cutset: string): string {
	if (n <= 0) return line;
	let cut = line.length - trimLeftSet(line, cutset).length;
	if (cut > n) cut = n;
	return line.slice(cut);
}

/** `line` without its leading run of characters drawn from `cutset`. */
function trimLeftSet(line: string, cutset: string): string {
	let i = 0;
	while (i < line.length && cutset.includes(line[i])) i++;
	return line.slice(i);
}

function countNewlines(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\n") n++;
	}
	return n;
}
