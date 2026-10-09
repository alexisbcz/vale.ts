/**
 * `$…$` and `$$…$$` math, read as something the linter skips.
 *
 * An equation is not prose, and spell-checking one produces nothing but noise.
 * Both forms are rendered as elements the walker already skips -- `pre` for a
 * display block, `code` for an inline span -- so no new skip rule is needed.
 *
 * The delimiter rules are Pandoc's, and they are what separates math from
 * money. In `$5 and $10` the second `$` has a space to its left, so it cannot
 * close a span: the sentence stays prose. A reader that pairs any two dollar
 * signs on a line hides `5 and 10` from every check, silently.
 */

import type MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

/** Adds the two math rules to a Markdown reader. */
export function mathPlugin(md: MarkdownIt): void {
	md.block.ruler.before("fence", "vale_math_block", mathBlock, {
		alt: ["paragraph", "reference", "blockquote", "list"],
	});
	md.inline.ruler.before("escape", "vale_math_inline", mathInline);

	md.renderer.rules.vale_math_block = (tokens, idx) =>
		`<pre>${escapeHTML(tokens[idx]!.content)}</pre>\n`;
	md.renderer.rules.vale_math_inline = (tokens, idx) =>
		`<code>${escapeHTML(tokens[idx]!.content)}</code>`;
}

/**
 * Reads `$$…$$` display math as a block.
 *
 * A `$$` at the start of a line opens it, and any line that ends with an
 * unescaped `$$` closes it -- alone on the line, ending a content line
 * (`\end{aligned}$$`), on the opening line itself (`$$x=1$$`), or trailed by a
 * `{…}` attribute, which is where Pandoc and Quarto put cross-reference labels.
 *
 * A blank line also closes the block. Pandoc will not carry display math across
 * one, so a `$$` that is never closed masks at most its own paragraph rather
 * than the remainder of the document.
 */
function mathBlock(
	state: StateBlock,
	startLine: number,
	endLine: number,
	silent: boolean,
): boolean {
	const indent = state.sCount[startLine]!;
	if (indent - state.blkIndent >= 4) return false;

	let pos = state.bMarks[startLine]! + state.tShift[startLine]!;
	const max = state.eMarks[startLine]!;
	const src = state.src;

	let dollars = 0;
	while (pos + dollars < max && src[pos + dollars] === "$") dollars++;
	if (dollars < 2) return false;
	if (silent) return true;

	pos += dollars;
	const firstLine = src.slice(pos, max);

	let content = "";
	let nextLine = startLine;

	const closerOnFirst = mathCloserIndex(firstLine);
	if (closerOnFirst >= 0) {
		// The block opens and closes on this line: `$$x=1$$`.
		content = firstLine.slice(0, closerOnFirst);
	} else {
		if (firstLine.trim() !== "") content = firstLine;
		for (nextLine = startLine + 1; nextLine < endLine; nextLine++) {
			const lineStart = state.bMarks[nextLine]! + state.tShift[nextLine]!;
			const lineEnd = state.eMarks[nextLine]!;
			const line = src.slice(lineStart, lineEnd);

			if (line.trim() === "") break;

			const closer = mathCloserIndex(line);
			if (closer >= 0) {
				if (line.slice(0, closer).trim() !== "") {
					content += (content === "" ? "" : "\n") + line.slice(0, closer);
				}
				break;
			}
			content += (content === "" ? "" : "\n") + line;
		}
	}

	const token = state.push("vale_math_block", "pre", 0);
	token.block = true;
	token.content = content;
	token.map = [startLine, nextLine + 1];

	state.line = nextLine + 1;
	return true;
}

/**
 * The index of the `$$` that closes display math on this line.
 *
 * One that ends the line, allowing trailing whitespace and at most one `{…}`
 * attribute after it. Returns -1 when the line closes nothing, including when
 * the `$$` is escaped.
 */
export function mathCloserIndex(line: string): number {
	let end = line.length;
	while (end > 0 && isSpace(line[end - 1]!)) end--;

	if (end > 0 && line[end - 1] === "}") {
		const open = line.lastIndexOf("{", end - 2);
		if (open < 0) return -1;
		end = open;
		while (end > 0 && isSpace(line[end - 1]!)) end--;
	}

	if (end < 2 || line[end - 1] !== "$" || line[end - 2] !== "$") return -1;
	if (end > 2 && line[end - 3] === "\\") return -1;
	return end - 2;
}

/**
 * Reads `$…$` inline math.
 *
 * The opening `$` must be followed by a non-space character, and the closing
 * `$` must be preceded by one and not followed by a digit.
 *
 * The span keeps its delimiters. The walker masks a skipped element with one
 * character per character of its text, so a mask that dropped them would be two
 * short of the source and every alert later in the paragraph would be placed
 * two columns early.
 */
function mathInline(state: StateInline, silent: boolean): boolean {
	const src = state.src;
	const start = state.pos;

	if (src[start] !== "$") return false;
	// `$$` opens display math, which the block rule owns.
	const after = src[start + 1];
	if (after === undefined || after === "$" || isSpace(after)) return false;

	for (let i = start + 1; i < state.posMax; i++) {
		if (!closesMath(src, i, state.posMax)) continue;
		if (!silent) {
			const token = state.push("vale_math_inline", "code", 0);
			token.markup = "$";
			token.content = src.slice(start, i + 1);
		}
		state.pos = i + 1;
		return true;
	}

	return false;
}

/**
 * Whether `src[i]` is a `$` that closes a span: one that is not escaped, has a
 * non-space character to its left, and is not followed by a digit.
 */
function closesMath(src: string, i: number, max: number): boolean {
	if (src[i] !== "$") return false;
	if (i > 0 && src[i - 1] === "\\") return false;
	if (i === 0 || isSpace(src[i - 1]!)) return false;
	if (i + 1 < max && src[i + 1]! >= "0" && src[i + 1]! <= "9") return false;
	return true;
}

function isSpace(c: string): boolean {
	return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

function escapeHTML(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
