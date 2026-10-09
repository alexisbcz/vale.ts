/**
 * Reading Markdown.
 *
 * Markdown is converted to HTML and then read by the one HTML reader every
 * format shares. What is specific to Markdown is what happens on either side of
 * that: the front matter is linted field by field before the conversion, and
 * the source is rewritten afterwards so that a match cannot be located inside
 * markup the conversion removed.
 *
 * That last part is subtle and worth stating. The reader places an alert by
 * finding its text in the *source*, which still holds the backticks, the link
 * references and the list markers that the HTML does not. A rule looking for
 * `json` would otherwise report the `json` in a fence's info string, so each of
 * those is masked with characters of the same width -- the positions stay, the
 * text goes.
 */

import type { Config, File } from "@vale-ts/core";
import { strLen } from "@vale-ts/core";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import { mathPlugin } from "./math.ts";

/** What a Markdown reader needs from the linter. */
export interface MarkdownHost {
	config: Config;
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
	lintMetadata(f: File): void;
}

/**
 * The Markdown dialect Vale reads.
 *
 * GitHub-flavored, with footnotes, and with raw HTML passed through -- a
 * documentation source is full of it, and a reader that escaped it would lint
 * the tags as prose.
 */
export function newMarkdown(): MarkdownIt {
	const md = new MarkdownIt("commonmark", {
		html: true,
		linkify: true,
		typographer: false,
	});

	// CommonMark's preset leaves these off; GitHub-flavored Markdown has them.
	md.enable(["table", "strikethrough"]);
	md.use(footnote);
	md.use(taskLists);
	md.use(mathPlugin);

	return md;
}

const sharedMarkdown = newMarkdown();

/** Reads a Markdown file. */
export function lintMarkdown(host: MarkdownHost, f: File): void {
	lintMarkdownWith(host, f, sharedMarkdown);
}

/**
 * Reads a file as Markdown through the given converter -- the plain dialect, or
 * a variant's such as MyST's.
 */
export function lintMarkdownWith(
	host: MarkdownHost,
	f: File,
	md: MarkdownIt,
): void {
	host.lintMetadata(f);

	const src = host.transform(f);
	const html = md.render(src);

	f.content = prepMarkdown(f.content);
	host.lintHTMLTokens(f, html, 0);
}

/** A fence's info string: everything after the opening backticks. */
const EXTENDED_INFO = /`{3,}.+/g;
/** A reference-style link's label: `[text][label]`. */
const LINK_REF = /\]\[(?:[^\]\n]+)\]/g;
/** A link definition's label: `[label]:`. */
const LINK_DEF = /\[(?:[^\]\n]+)\]:/g;
/** An ordered list's marker. */
const NUMERIC_LIST = /^\d+\./gm;

/**
 * Masks the parts of the Markdown source that are markup rather than prose.
 *
 * Each is replaced by a run of `*` of the same width, so an alert's column is
 * unchanged and nothing in it can be matched. The alternative -- searching the
 * rendered HTML instead -- loses the source positions entirely.
 */
export function prepMarkdown(content: string): string {
	// A fence's info string would otherwise be found by a rule looking for the
	// language it names. The number of opening backticks is respected, since it
	// may be more than three.
	let body = content.replace(EXTENDED_INFO, (m) => {
		const parts = m.split("`");
		const tags = "`".repeat(parts.length - 1);
		const span = "*".repeat(strLen(parts[parts.length - 1] ?? ""));
		return tags + span;
	});

	body = body.replace(LINK_REF, (m) => `][${"*".repeat(strLen(m) - 3)}]`);
	body = body.replace(LINK_DEF, (m) => `[${"*".repeat(strLen(m) - 3)}]:`);
	body = body.replace(NUMERIC_LIST, (m) => "*".repeat(strLen(m)));

	return body;
}
