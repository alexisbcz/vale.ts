/**
 * Reading Quarto: Pandoc Markdown plus knitr- and Jupyter-style code cells.
 *
 * The cells already read as fenced code and code spans, so what needs parsing
 * is the Pandoc layer: fenced divs, attributes, and shortcodes. See #793.
 *
 * A fenced div's classes become class scopes (`class.callout-note`) for
 * everything inside it, and its fence lines are markup. Attributes and
 * shortcodes render as nothing at all.
 */

import type { File } from "@vale-ts/core";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { mathPlugin } from "./math.ts";
import { lintMarkdownWith, type MarkdownHost } from "./md.ts";

/** What a Quarto reader needs from the linter. */
export type QuartoHost = MarkdownHost;

/** `{{< shortcode ... >}}` */
const RE_SHORTCODE = /^\{\{<[^\n]*?>\}\}/;
/** `{#id .class key="val"}` -- an identifier or class attribute. */
const RE_ATTRS = /^\{[#.][^{}\n]*\}/;
/** Any braced attributes directly after a `]`. */
const RE_ATTRS_AFTER = /^\{[^{}\n]*\}/;

/**
 * Reads a fenced-div line: at least three colons, then -- for an opener --
 * attributes or a bare name.
 *
 * Returns what follows the colons, or null when the line is not a fence.
 */
function readFence(state: StateBlock, line: number): string | null {
	const pos = state.bMarks[line] + state.tShift[line];
	const max = state.eMarks[line];
	if (state.src[pos] !== ":") return null;

	let i = pos;
	while (i < max && state.src[i] === ":") i++;
	if (i - pos < 3) return null;

	return state.src.slice(i, max).trim();
}

/**
 * The class names in a div opener's attributes.
 *
 * `{.callout-note title="x"}` and the bare-word form `warning` alike;
 * anything that is not a class is dropped, since it is a setting rather than
 * something to read.
 */
export function quartoClasses(restArg: string): string[] {
	const rest = restArg.trim();

	if (rest.startsWith("{")) {
		const found: string[] = [];
		for (const field of rest.replace(/^\{+/, "").replace(/\}+$/, "").split(/\s+/)) {
			if (field.startsWith(".")) found.push(field.slice(1));
		}
		return found;
	}

	const fields = rest.split(/\s+/).filter((x) => x !== "");
	return fields.length > 0 ? [fields[0]] : [];
}

/**
 * Reads one fenced div.
 *
 * A bare fence closes the innermost open div, so the matching closer is found
 * by counting the openers in between: an opener nested inside is parsed on its
 * own and takes its own closer with it.
 */
function quartoDiv(
	state: StateBlock,
	startLine: number,
	endLine: number,
	silent: boolean,
): boolean {
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;

	const rest = readFence(state, startLine);
	if (rest === null) return false;

	if (rest === "") {
		// A stray closer with no open div: markup, nothing more.
		if (!silent) state.push("quarto_markup", "", 0);
		state.line = startLine + 1;
		return true;
	}
	if (silent) return true;

	const classes = quartoClasses(rest);

	let depth = 1;
	let close = -1;
	for (let line = startLine + 1; line < endLine; line++) {
		if (state.sCount[line] - state.blkIndent >= 4) continue;
		const fence = readFence(state, line);
		if (fence === null) continue;
		if (fence === "") {
			depth--;
			if (depth === 0) {
				close = line;
				break;
			}
		} else {
			depth++;
		}
	}

	const last = close < 0 ? endLine : close;

	const open = state.push("quarto_div_open", "div", 1);
	open.block = true;
	open.meta = { classes };
	open.map = [startLine, last];

	const oldMax = state.lineMax;
	state.lineMax = last;
	state.md.block.tokenize(state, startLine + 1, last);
	state.lineMax = oldMax;

	state.push("quarto_div_close", "div", -1).block = true;

	state.line = close < 0 ? last : close + 1;
	return true;
}

/** Reads inline Pandoc syntax with nothing to lint: a shortcode, or attributes. */
function quartoInline(state: StateInline, silent: boolean): boolean {
	const start = state.pos;
	if (state.src[start] !== "{") return false;

	const line = state.src.slice(start, state.posMax);

	// `{{< shortcode >}}`
	const shortcode = RE_SHORTCODE.exec(line);
	if (shortcode !== null) {
		if (!silent) state.push("quarto_markup", "", 0);
		state.pos = start + shortcode[0].length;
		return true;
	}

	// `{#id}` / `{.class}` -- a heading's or a span's attributes.
	const attrs = RE_ATTRS.exec(line);
	if (attrs !== null) {
		if (!silent) state.push("quarto_markup", "", 0);
		state.pos = start + attrs[0].length;
		return true;
	}

	// `[text]{lang="fr"}` -- any attributes directly after a bracket.
	if (start > 0 && state.src[start - 1] === "]") {
		const after = RE_ATTRS_AFTER.exec(line);
		if (after !== null) {
			if (!silent) state.push("quarto_markup", "", 0);
			state.pos = start + after[0].length;
			return true;
		}
	}

	return false;
}

function escapeHTML(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** The Quarto dialect Vale reads. */
export function newQuarto(): MarkdownIt {
	const md = new MarkdownIt("commonmark", {
		html: true,
		linkify: true,
		typographer: false,
	});

	md.enable(["table", "strikethrough"]);
	md.use(footnote);
	md.use(taskLists);
	md.use(mathPlugin);

	// Ahead of the paragraph rule; `:` has no built-in owner.
	md.block.ruler.before("paragraph", "quarto_div", quartoDiv, {
		alt: ["paragraph", "reference", "blockquote", "list"],
	});
	md.inline.ruler.before("escape", "quarto_inline", quartoInline);

	md.renderer.rules.quarto_markup = () => "";
	md.renderer.rules.quarto_div_open = (tokens, idx) => {
		const classes = (tokens[idx].meta as { classes: string[] }).classes;
		if (classes.length === 0) return "<div>\n";
		return `<div class="${escapeHTML(classes.join(" "))}">\n`;
	};
	md.renderer.rules.quarto_div_close = () => "</div>\n";

	return md;
}

const sharedQuarto = newQuarto();

/** Reads a Quarto file: Markdown, parsed with the Pandoc constructs. */
export function lintQuarto(host: QuartoHost, f: File): void {
	lintMarkdownWith(host, f, sharedQuarto);
}
