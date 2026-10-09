/**
 * Reading MyST: CommonMark plus the Sphinx-style constructs a plain Markdown
 * parser reads as prose.
 *
 * Directives, roles, targets, comments and block breaks are parsed into
 * shapes the walker already understands. See #667.
 *
 * A directive's content is Markdown by specification, so a prose directive
 * becomes `<div class="<name>">` and its content is linted with the
 * directive's name as a class scope (`text.class.note`). A directive whose
 * content is literal -- code, math, raw markup -- becomes `<pre>`, which the
 * walker skips. Everything else -- targets, comments, block breaks, options,
 * role and attribute braces -- renders as nothing at all.
 *
 * A project's `[sphinx]` section adds to both lists, so the converter is
 * built per configuration rather than shared.
 */

import type { Config, File } from "@vale-ts/core";
import MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import { mathPlugin } from "./math.ts";
import { lintMarkdownWith, type MarkdownHost } from "./md.ts";

/** What a MyST reader needs from the linter. */
export type MySTHost = MarkdownHost;

/**
 * The directives whose content is not prose.
 *
 * A project's `[sphinx] CodeDirectives` adds to this.
 */
const LITERAL = new Set([
	"code",
	"code-block",
	"code-cell",
	"csv-table",
	"eval-rst",
	"highlight",
	"include",
	"literalinclude",
	"math",
	"mermaid",
	"raw",
	"sourcecode",
	"toctree",
]);

/**
 * The roles whose content is prose rather than an identifier, and the ones
 * among them whose bare content is a target -- code, unless a title is
 * written before it in angle brackets.
 *
 * The same two lists the reStructuredText server carries; see `rst.ts`.
 */
const PROSE_ROLES = new Set([
	"ref",
	"doc",
	"any",
	"numref",
	"term",
	"guilabel",
	"menuselection",
	"abbr",
	"dfn",
]);
const TARGETED = new Set(["ref", "doc", "any", "numref"]);

/** `{name}`, the info string that makes a fence a directive. */
const RE_NAME = /^\{([A-Za-z0-9:._+-]+)\}/;
/** `(my-label)=` on a line of its own. */
const RE_TARGET = /^\(\S+\)=\s*$/;
/** `{.class}` / `{#id}` / `{style=...}` on a line of its own. */
const RE_ATTRS_BLOCK = /^\{[^{}\n]*\}\s*$/;
/** `:key: value` under a directive opener. */
const RE_OPTION = /^\s{0,3}:[^:\s][^:\n]*:/;
/** `{role}` immediately followed by a code span. */
const RE_ROLE = /^\{[A-Za-z][A-Za-z0-9:._+-]*\}`/;
/** `{{ substitution }}` */
const RE_SUB = /^\{\{[^{}\n]*\}\}/;
/** The `{.class}` of a `[text]{.class}` inline attribute. */
const RE_ATTRS_INLINE = /^\{[^{}\n]*\}/;
/** `text <target>` */
const RE_TITLE = /^([\s\S]*\S)\s*<[^<>]+>$/;

/** A project's `[sphinx]` section as the rules read it. */
interface Sphinx {
	code: Set<string>;
	prose: Set<string>;
}

function sphinxOf(cfg: Config): Sphinx {
	return {
		code: new Set(cfg.sphinxNames("CodeDirectives")),
		prose: new Set(cfg.sphinxNames("ProseRoles")),
	};
}

/**
 * A directive's content, read from a prose role's braces.
 *
 * Returns the text to lint and how far the whole role reaches, or null when
 * the role's content is not prose.
 */
function roleText(
	line: string,
	at: number,
	sphinx: Sphinx,
): { text: string; end: number } | null {
	const qualified = line.slice(1, at - 1).toLowerCase();
	const colon = qualified.lastIndexOf(":");
	const name = colon >= 0 ? qualified.slice(colon + 1) : qualified;
	if (!PROSE_ROLES.has(name) && !sphinx.prose.has(name)) return null;

	// The span's opening run of backticks, then the matching closing run.
	const rest = line.slice(at);
	let ticks = 0;
	while (ticks < rest.length && rest[ticks] === "`") ticks++;
	const end = rest.slice(ticks).indexOf(rest.slice(0, ticks));
	if (ticks === 0 || end < 0) return null;

	let content = rest.slice(ticks, ticks + end).trim();
	const titled = RE_TITLE.exec(content);
	if (titled !== null) content = titled[1];
	else if (TARGETED.has(name)) return null;

	return { text: content, end: at + ticks + end + ticks };
}

/** The text of a line, without its newline. */
function lineText(state: StateBlock, line: number): string {
	return state.src.slice(
		state.bMarks[line] + state.tShift[line],
		state.eMarks[line],
	);
}

/** A fence's marker, its length, and what follows it, or null. */
function readFence(
	state: StateBlock,
	line: number,
): { marker: string; size: number; rest: string } | null {
	const pos = state.bMarks[line] + state.tShift[line];
	const max = state.eMarks[line];
	const marker = state.src[pos];
	if (marker !== "`" && marker !== "~" && marker !== ":") return null;

	let i = pos;
	while (i < max && state.src[i] === marker) i++;
	const size = i - pos;
	if (size < 3) return null;

	return { marker, size, rest: state.src.slice(i, max) };
}

/**
 * Reads one fenced directive: ```` ```{name} ````, `~~~{name}`, or
 * `:::{name}`.
 */
function directiveRule(sphinx: Sphinx) {
	return function mystDirective(
		state: StateBlock,
		startLine: number,
		endLine: number,
		silent: boolean,
	): boolean {
		if (state.sCount[startLine] - state.blkIndent >= 4) return false;

		const fence = readFence(state, startLine);
		if (fence === null) return false;

		const named = RE_NAME.exec(fence.rest.replace(/^[ \t]+/, ""));
		if (named === null) {
			// Not a directive. A bare colon fence is not Markdown either, but
			// there is no built-in rule to fall through to -- so it is treated
			// as markup and discarded, closing any open colon directive.
			if (fence.marker === ":" && fence.rest.trim() === "") {
				if (!silent) state.push("myst_markup", "", 0);
				state.line = startLine + 1;
				return true;
			}
			return false;
		}
		if (silent) return true;

		const name = named[1];
		const literal = LITERAL.has(name) || sphinx.code.has(name.toLowerCase());

		// `opts` tracks the option lines under the opener: 1 while a field
		// list may continue, 2 inside a `---`-delimited YAML block, 0 once
		// content has begun. Neither is prose.
		let opts = 1;
		let contentStart = -1;
		let contentEnd = -1;
		let close = -1;

		for (let line = startLine + 1; line < endLine; line++) {
			// The closing fence: at least as many markers as the opener, alone
			// on a line.
			if (state.sCount[line] - state.blkIndent < 4) {
				const end = readFence(state, line);
				if (
					end !== null &&
					end.marker === fence.marker &&
					end.size >= fence.size &&
					end.rest.trim() === ""
				) {
					close = line;
					break;
				}
			}

			const text = lineText(state, line);
			if (opts === 2) {
				if (text.startsWith("---")) opts = 0;
				continue;
			}
			if (opts === 1) {
				if (text.startsWith("---")) {
					opts = 2;
					continue;
				}
				if (RE_OPTION.test(text)) continue;
				opts = 0;
			}

			if (contentStart < 0) contentStart = line;
			contentEnd = line + 1;
		}

		const last = close < 0 ? endLine : close;
		if (contentStart < 0) {
			contentStart = Math.min(startLine + 1, last);
			contentEnd = contentStart;
		}

		if (literal) {
			const token = state.push("myst_literal", "pre", 0);
			token.block = true;
			token.markup = fence.marker.repeat(fence.size);
			token.content =
				contentEnd > contentStart
					? state.getLines(contentStart, contentEnd, state.blkIndent, true)
					: "";
			token.map = [startLine, last];
		} else {
			const open = state.push("myst_directive_open", "div", 1);
			open.block = true;
			open.markup = fence.marker.repeat(fence.size);
			open.meta = { name };
			open.map = [startLine, last];

			const oldMax = state.lineMax;
			state.lineMax = contentEnd;
			state.md.block.tokenize(state, contentStart, contentEnd);
			state.lineMax = oldMax;

			state.push("myst_directive_close", "div", -1).block = true;
		}

		state.line = close < 0 ? last : close + 1;
		return true;
	};
}

/**
 * Reads one line of MyST syntax with nothing to lint: a target, a comment, a
 * block break, or an attributes line.
 */
function mystMarkup(
	state: StateBlock,
	startLine: number,
	_endLine: number,
	silent: boolean,
): boolean {
	if (state.sCount[startLine] - state.blkIndent >= 4) return false;

	const pos = state.bMarks[startLine] + state.tShift[startLine];
	const max = state.eMarks[startLine];
	const rest = state.src.slice(pos, max);

	let matched = false;
	switch (state.src[pos]) {
		case "%":
			matched = true;
			break;
		case "+": {
			let i = pos;
			while (i < max && state.src[i] === "+") i++;
			matched = i - pos >= 3;
			break;
		}
		case "(":
			matched = RE_TARGET.test(rest);
			break;
		case "{":
			matched = RE_ATTRS_BLOCK.test(rest);
			break;
		default:
			break;
	}
	if (!matched) return false;

	if (!silent) state.push("myst_markup", "", 0);
	state.line = startLine + 1;
	return true;
}

/**
 * Reads inline MyST syntax: a role's braces, a substitution, or an inline
 * attribute.
 */
function inlineRule(sphinx: Sphinx) {
	return function mystInline(state: StateInline, silent: boolean): boolean {
		const start = state.pos;
		if (state.src[start] !== "{") return false;

		const line = state.src.slice(start, state.posMax);

		// `{{ substitution }}`
		const sub = RE_SUB.exec(line);
		if (sub !== null) {
			if (!silent) state.push("myst_markup", "", 0);
			state.pos = start + sub[0].length;
			return true;
		}

		// `{role}`content`` -- the braces alone, so that the code span that
		// follows is skipped as inline code: a role's content is an
		// identifier. Except for the roles whose content is prose, which is
		// read as text -- its title, when one is written before a target in
		// angle brackets.
		const role = RE_ROLE.exec(line);
		if (role !== null) {
			const at = role[0].length - 1;
			const prose = roleText(line, at, sphinx);
			if (prose !== null) {
				if (!silent) {
					const token = state.push("text", "", 0);
					token.content = prose.text;
				}
				state.pos = start + prose.end;
				return true;
			}
			if (!silent) state.push("myst_markup", "", 0);
			state.pos = start + at;
			return true;
		}

		// `[text]{.class}` -- the braces follow the closing bracket.
		if (start > 0 && state.src[start - 1] === "]") {
			const attrs = RE_ATTRS_INLINE.exec(line);
			if (attrs !== null) {
				if (!silent) state.push("myst_markup", "", 0);
				state.pos = start + attrs[0].length;
				return true;
			}
		}

		return false;
	};
}

function escapeHTML(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** The MyST dialect Vale reads, for one configuration's `[sphinx]` section. */
export function newMyST(cfg: Config): MarkdownIt {
	const sphinx = sphinxOf(cfg);

	const md = new MarkdownIt("commonmark", {
		html: true,
		linkify: true,
		typographer: false,
	});

	md.enable(["table", "strikethrough"]);
	md.use(footnote);
	md.use(taskLists);
	md.use(mathPlugin);

	// Ahead of the fenced-code rule, so a fence opening a directive is read as
	// one; a plain fence falls through to it.
	md.block.ruler.before("fence", "myst_directive", directiveRule(sphinx), {
		alt: ["paragraph", "reference", "blockquote", "list"],
	});
	// Ahead of the paragraph rule, which would otherwise read these lines as
	// prose.
	md.block.ruler.before("paragraph", "myst_markup", mystMarkup, {
		alt: ["paragraph", "reference", "blockquote", "list"],
	});
	md.inline.ruler.before("escape", "myst_inline", inlineRule(sphinx));

	md.renderer.rules.myst_markup = () => "";
	md.renderer.rules.myst_literal = (tokens, idx) =>
		`<pre>${escapeHTML(tokens[idx].content)}</pre>\n`;
	md.renderer.rules.myst_directive_open = (tokens, idx) =>
		`<div class="${escapeHTML((tokens[idx].meta as { name: string }).name)}">\n`;
	md.renderer.rules.myst_directive_close = () => "</div>\n";

	return md;
}

/** The converter for each configuration, built once. */
const converters = new WeakMap<Config, MarkdownIt>();

/** Reads a MyST file: Markdown, parsed with the MyST constructs. */
export function lintMyST(host: MySTHost, f: File): void {
	let md = converters.get(host.config);
	if (md === undefined) {
		md = newMyST(host.config);
		converters.set(host.config, md);
	}
	lintMarkdownWith(host, f, md);
}
