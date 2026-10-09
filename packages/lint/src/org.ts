/**
 * Reading Org mode.
 *
 * Go hands the document to `niklasfasching/go-org`. There is no TypeScript
 * equivalent, so the converter here is Vale's own: enough of Org to turn a
 * document into the HTML the walker reads, written against the same shapes
 * Vale's Org fixtures exercise.
 *
 * # What it covers
 *
 * Headlines, with their TODO keywords and priority cookies; keyword lines
 * (`#+title:`, `#+author:`) and comments; `#+begin_…`/`#+end_…` blocks, with
 * `src`, `example`, `export` and `verse` read as literal and `quote` and
 * `center` as prose; drawers, including `:PROPERTIES:`; planning lines
 * (`CLOSED:`, `SCHEDULED:`, `DEADLINE:`); plain, ordered and description
 * lists; tables, with a rule row making the rows above it a header; footnote
 * definitions and references; horizontal rules; and the inline markup --
 * `*bold*`, `/italic/`, `_underline_`, `+strike+`, `=verbatim=`, `~code~`,
 * `[[target][description]]`, `[fn:…]`, and `<…>` timestamps.
 *
 * # What it does not
 *
 * Macros, `#+include:` expansion, `#+call:` and anything else that would pull
 * in content the file does not hold -- Vale lints what is written, not what
 * Org would produce. Radio targets, LaTeX fragments, entities (`\alpha`),
 * subscripts and superscripts, and tags beyond the headline stripping below
 * are passed through as text. Nested emphasis is read one level deep inside
 * `*`, `/`, `_` and `+`; `=` and `~` are verbatim, as Org says.
 *
 * # Where the title and the footnotes go
 *
 * go-org writes the title at the top of the document and collects every
 * footnote definition at the end. Neither is where the source has them, and
 * an alert in one was then reported wherever the text next happened to match.
 * Both are written in place here, which is what Vale's go-org writer
 * overrides do.
 */

import type { Config, File } from "@vale-ts/core";
import { strLen } from "@vale-ts/core";

/** What an Org reader needs from the linter. */
export interface OrgHost {
	config: Config;
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
	lintMetadata(f: File): void;
}

/** A keyword line: `#+key: value`, or `# key: value`. */
const RE_ORG_ATTRIBUTE = /(#(?:\+| )[^\s]+:.+)/g;

/** A properties drawer, which holds settings rather than prose. */
const RE_ORG_PROPS = /(:PROPERTIES:\n[\s\S]+?\n:END:)/g;

/** A source block's opening line, masked out of the source. */
const RE_ORG_SRC = /#\+BEGIN_SRC .+/gi;

/** The tags at the end of a headline, `:work:urgent:`. */
const RE_ORG_TAGS = /^\*+[ \t]+.*?([ \t]+:[\w@#%:]+:)[ \t]*$/gm;

const ORG_EXAMPLE = "\n#+BEGIN_EXAMPLE\n$1\n#+END_EXAMPLE\n";

/**
 * The keywords whose value is prose: the document's title, its author, and
 * what it says about itself. Every other keyword holds a setting, and is
 * hidden from the converter as verbatim text.
 */
const ORG_PROSE_KEYS = new Set(["TITLE", "SUBTITLE", "AUTHOR", "DESCRIPTION"]);

/** The key of a keyword line as `RE_ORG_ATTRIBUTE` matched it. */
function orgKeywordKey(line: string): string {
	const colon = line.indexOf(":");
	const key = colon < 0 ? line : line.slice(0, colon);
	return key.replace(/^[#+ ]+/, "").toUpperCase();
}

/** Reads an Org file. */
export function lintOrg(host: OrgHost, f: File): void {
	const old = f.content;

	let s = f.content.replace(RE_ORG_ATTRIBUTE, (m) =>
		ORG_PROSE_KEYS.has(orgKeywordKey(m)) ? m : `\n=${m}=\n`,
	);
	s = s.replace(RE_ORG_PROPS, ORG_EXAMPLE);

	// A headline's tags are labels, not part of its text. They are blanked
	// rather than removed so a column in the headline is still a column in
	// the source.
	s = s.replace(RE_ORG_TAGS, (m, tags: string) => {
		const at = m.lastIndexOf(tags);
		return m.slice(0, at) + " ".repeat(tags.length) + m.slice(at + tags.length);
	});

	f.content = s;
	try {
		host.lintMetadata(f);
		s = host.transform(f);
	} finally {
		f.content = old;
	}

	// A match must not be found in a `begin_src` line, which names a language
	// rather than saying anything.
	const body = f.content.replace(RE_ORG_SRC, (m) => "*".repeat(strLen(m)));

	const html = orgToHTML(s);

	f.content = body;
	host.lintHTMLTokens(f, html, 0);
}

// --- the converter ----------------------------------------------------------

/** The blocks whose content is not prose. */
const LITERAL_BLOCKS = new Set(["src", "example", "export", "verse", "comment"]);

/** The blocks whose content is prose, and the element each becomes. */
const PROSE_BLOCKS: Readonly<Record<string, string>> = {
	quote: "blockquote",
	center: "div",
	abstract: "div",
};

const RE_HEADLINE = /^(\*+)\s+(.*)$/;
const RE_KEYWORD = /^\s*#\+([^\s:]+):\s*(.*)$/;
const RE_COMMENT = /^\s*#(?:\s+(.*)|)$/;
const RE_BLOCK_START = /^\s*#\+begin_([a-zA-Z]+)\s*(.*)$/i;
const RE_BLOCK_END = /^\s*#\+end_([a-zA-Z]+)\s*$/i;
const RE_DRAWER_START = /^\s*:([\w@#%]+):\s*$/;
const RE_DRAWER_END = /^\s*:END:\s*$/i;
const RE_PLANNING = /^\s*(?:CLOSED|SCHEDULED|DEADLINE):/;
const RE_RULE = /^\s*-{5,}\s*$/;
const RE_LIST_ITEM = /^(\s*)(?:([-+*])|(\d+)[.)])\s+(.*)$/;
const RE_DESCRIPTION = /^(.*?)\s+::\s+(.*)$/;
const RE_TABLE_ROW = /^\s*\|(.*)$/;
const RE_TABLE_RULE = /^\s*\|[-+|\s]*$/;
const RE_FOOTNOTE_DEF = /^\s*\[fn:([^\]]*)\]\s*(.*)$/;

/** A headline's TODO keywords, which Org treats as state rather than prose. */
const TODO_KEYWORDS = new Set(["TODO", "DONE", "NEXT", "WAITING", "CANCELLED"]);

/** Converts an Org document to HTML. */
export function orgToHTML(src: string): string {
	const lines = src.split("\n");
	const out: string[] = [];
	const para: string[] = [];
	const listStack: Array<{ indent: number; tag: string }> = [];

	/** Writes the pending paragraph, if any. */
	const flush = (): void => {
		if (para.length === 0) return;
		const text = inline(para.join("\n"));
		para.length = 0;
		if (listStack.length > 0) out.push(`${text}\n`);
		else out.push(`<p>${text}</p>\n`);
	};

	/** Closes every open list down to `indent`. */
	const closeLists = (indent: number): void => {
		while (
			listStack.length > 0 &&
			listStack[listStack.length - 1].indent >= indent
		) {
			flush();
			out.push("</li>\n");
			out.push(`</${listStack.pop().tag}>\n`);
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// A block runs to its matching `#+end_…`; what is inside it is never
		// read as Org.
		const block = RE_BLOCK_START.exec(line);
		if (block !== null) {
			flush();
			closeLists(0);
			const name = block[1].toLowerCase();
			const held: string[] = [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const end = RE_BLOCK_END.exec(lines[j]);
				if (end !== null && end[1].toLowerCase() === name) break;
				held.push(lines[j]);
			}
			i = j;

			if (name === "comment") {
				// Nothing: a comment block is not published.
			} else if (LITERAL_BLOCKS.has(name)) {
				out.push(`<pre>${escapeHTML(held.join("\n"))}</pre>\n`);
			} else {
				const tag = PROSE_BLOCKS[name] ?? "div";
				out.push(`<${tag}>\n${orgToHTML(held.join("\n"))}</${tag}>\n`);
			}
			continue;
		}

		// A drawer holds properties and logbook entries, never prose.
		if (RE_DRAWER_START.test(line) && !RE_DRAWER_END.test(line)) {
			flush();
			let j = i + 1;
			while (j < lines.length && !RE_DRAWER_END.test(lines[j])) j++;
			i = j;
			continue;
		}

		if (RE_PLANNING.test(line)) {
			flush();
			continue;
		}

		const headline = RE_HEADLINE.exec(line);
		if (headline !== null) {
			flush();
			closeLists(0);
			out.push(headlineHTML(headline[1].length, headline[2]));
			continue;
		}

		const keyword = RE_KEYWORD.exec(line);
		if (keyword !== null) {
			flush();
			out.push(keywordHTML(keyword[1], keyword[2]));
			continue;
		}

		// `# text` is a comment. It reaches the walker as an HTML comment, so
		// that Vale's own `vale off` directives keep working in Org.
		const comment = RE_COMMENT.exec(line);
		if (comment !== null) {
			flush();
			out.push(`<!-- ${comment[1] ?? ""} -->\n`);
			continue;
		}

		if (RE_RULE.test(line)) {
			flush();
			closeLists(0);
			out.push("<hr>\n");
			continue;
		}

		if (RE_TABLE_ROW.test(line)) {
			flush();
			closeLists(0);
			const rows: string[] = [];
			let j = i;
			for (; j < lines.length && RE_TABLE_ROW.test(lines[j]); j++) {
				rows.push(lines[j]);
			}
			i = j - 1;
			out.push(tableHTML(rows));
			continue;
		}

		const footnote = RE_FOOTNOTE_DEF.exec(line);
		if (footnote !== null) {
			flush();
			closeLists(0);
			// The definition's body is written where the source has it, not
			// collected at the end of the document.
			out.push(
				`<div class="footnote-definition">${inline(footnote[2])}</div>\n`,
			);
			continue;
		}

		const item = RE_LIST_ITEM.exec(line);
		if (item !== null) {
			const indent = item[1].length;
			const tag = item[2] !== undefined ? "ul" : "ol";

			closeLists(indent + 1);
			const top = listStack[listStack.length - 1];
			if (top === undefined || top.indent < indent) {
				out.push(`<${tag}>\n`);
				listStack.push({ indent, tag });
			} else {
				flush();
				out.push("</li>\n");
			}
			out.push("<li>");

			const described = RE_DESCRIPTION.exec(item[4]);
			if (described !== null) {
				out.push(`<strong>${inline(described[1])}</strong> `);
				if (described[2] !== "") para.push(described[2]);
			} else if (item[4] !== "") {
				para.push(item[4]);
			}
			continue;
		}

		if (trimmed === "") {
			flush();
			closeLists(0);
			continue;
		}

		para.push(line);
	}

	flush();
	closeLists(0);
	return out.join("");
}

/**
 * A headline, as a heading of its own depth.
 *
 * A TODO keyword and a priority cookie are state rather than prose, and are
 * written as elements a rule about prose does not reach.
 */
function headlineHTML(depth: number, textArg: string): string {
	let text = textArg;
	let state = "";

	const first = text.split(/\s+/, 1)[0] ?? "";
	if (TODO_KEYWORDS.has(first)) {
		state = `<span class="todo">${escapeHTML(first)}</span> `;
		text = text.slice(first.length).trimStart();
	}

	const priority = /^\[#([A-Za-z])\]\s*/.exec(text);
	if (priority !== null) {
		state += `<span class="priority">${escapeHTML(priority[1])}</span> `;
		text = text.slice(priority[0].length);
	}

	const level = Math.min(depth, 6);
	return `<h${level}>${state}${inline(text)}</h${level}>\n`;
}

/**
 * A keyword line.
 *
 * A prose keyword is written where the source has it -- the title as a
 * heading, the author or the description as a paragraph. Everything else is a
 * setting; the preprocessing in `lintOrg` has already wrapped those as
 * verbatim, so one reaching here is written as code.
 */
function keywordHTML(keyArg: string, value: string): string {
	const key = keyArg.toUpperCase();
	if (key === "TITLE" || key === "SUBTITLE") {
		return `<h1 class="title">${inline(value)}</h1>\n`;
	}
	if (key === "AUTHOR" || key === "DESCRIPTION") {
		return `<p class="${key.toLowerCase()}">${inline(value)}</p>\n`;
	}
	return `<pre>${escapeHTML(value)}</pre>\n`;
}

/**
 * A table.
 *
 * A rule row (`|---|`) makes everything above it the header, which is how Org
 * marks one; a table with no rule is all body.
 */
function tableHTML(rows: readonly string[]): string {
	const rule = rows.findIndex((r) => RE_TABLE_RULE.test(r));
	let out = "<table>\n";

	for (let i = 0; i < rows.length; i++) {
		if (RE_TABLE_RULE.test(rows[i])) continue;
		const tag = rule > 0 && i < rule ? "th" : "td";
		const cells = rows[i]
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|");
		out += "<tr>";
		for (const cell of cells) out += `<${tag}>${inline(cell.trim())}</${tag}>`;
		out += "</tr>\n";
	}

	return `${out}</table>\n`;
}

/** The emphasis markers, and the element each one becomes. */
const EMPHASIS: Readonly<Record<string, string>> = {
	"*": "strong",
	"/": "em",
	_: "u",
	"+": "del",
	"=": "code",
	"~": "code",
};

/** The markers whose content is verbatim: no markup is read inside them. */
const VERBATIM = new Set(["=", "~"]);

/** What may precede an opening marker. */
const PRE_CHARS = new Set([" ", "\t", "\n", "-", "(", "{", "'", '"', ""]);
/** What may follow a closing marker. */
const POST_CHARS = new Set([
	" ",
	"\t",
	"\n",
	"-",
	".",
	",",
	";",
	":",
	"!",
	"?",
	"'",
	")",
	"}",
	'"',
	"[",
	"",
]);

/**
 * Renders a run of Org text: links, footnote references, timestamps and
 * emphasis.
 *
 * Org's own rule for emphasis is a five-part pattern -- what precedes the
 * marker, the marker, a body that neither begins nor ends with whitespace,
 * the marker again, and what follows it -- and that is what is checked here.
 * Without it, `5 * 3 and 2 * 4` is one bold span and the arithmetic
 * disappears from the document.
 */
export function inline(text: string): string {
	let out = "";
	let i = 0;
	let plain = "";

	const take = (): void => {
		if (plain !== "") {
			out += escapeHTML(plain);
			plain = "";
		}
	};

	while (i < text.length) {
		const c = text[i];

		// `[[target][description]]`, `[[target]]`, `[fn:name]`, `[fn:name:body]`.
		if (c === "[") {
			const link = readLink(text, i);
			if (link !== null) {
				take();
				out += link.html;
				i = link.end;
				continue;
			}
			const note = readFootnote(text, i);
			if (note !== null) {
				take();
				out += note.html;
				i = note.end;
				continue;
			}
			// A bare `[2020-10-27 Tue]` timestamp: a date, not prose.
			const stamp = timestampEnd(text, i, "[", "]");
			if (stamp >= 0) {
				take();
				i = stamp;
				continue;
			}
		}

		if (c === "<") {
			const stamp = timestampEnd(text, i, "<", ">");
			if (stamp >= 0) {
				take();
				i = stamp;
				continue;
			}
		}

		const tag = EMPHASIS[c];
		if (tag !== undefined && PRE_CHARS.has(i === 0 ? "" : text[i - 1])) {
			const span = readEmphasis(text, i, c);
			if (span !== null) {
				take();
				const body = VERBATIM.has(c)
					? escapeHTML(span.body)
					: inline(span.body);
				out += `<${tag}>${body}</${tag}>`;
				i = span.end;
				continue;
			}
		}

		plain += c;
		i++;
	}

	take();
	return out;
}

/** An emphasis span opening at `at`, or null. */
function readEmphasis(
	text: string,
	at: number,
	marker: string,
): { body: string; end: number } | null {
	if (at + 2 >= text.length) return null;
	if (isSpace(text[at + 1])) return null;

	for (let j = at + 2; j < text.length; j++) {
		if (text[j] !== marker) continue;
		if (isSpace(text[j - 1])) continue;
		const after = j + 1 < text.length ? text[j + 1] : "";
		if (!POST_CHARS.has(after)) continue;
		return { body: text.slice(at + 1, j), end: j + 1 };
	}
	return null;
}

/**
 * A link opening at `at`, or null.
 *
 * The description is the prose; the target is a path or a URL, so a link with
 * no description contributes nothing to read.
 */
function readLink(text: string, at: number): { html: string; end: number } | null {
	if (!text.startsWith("[[", at)) return null;
	const close = text.indexOf("]]", at + 2);
	if (close < 0) return null;

	const body = text.slice(at + 2, close);
	const split = body.indexOf("][");
	const target = split < 0 ? body : body.slice(0, split);
	const label = split < 0 ? "" : body.slice(split + 2);

	return {
		html: `<a href="${escapeAttr(target)}">${label === "" ? "" : inline(label)}</a>`,
		end: close + 2,
	};
}

/**
 * A footnote reference opening at `at`, or null.
 *
 * An inline definition -- `[fn:name:the text]` -- holds prose and is written
 * in place. A plain reference holds a label, and the number go-org writes for
 * one is not in the source, so it writes nothing.
 */
function readFootnote(
	text: string,
	at: number,
): { html: string; end: number } | null {
	if (!text.startsWith("[fn:", at)) return null;
	const close = text.indexOf("]", at + 4);
	if (close < 0) return null;

	const body = text.slice(at + 4, close);
	const split = body.indexOf(":");
	if (split < 0) return { html: "", end: close + 1 };

	return { html: inline(body.slice(split + 1)), end: close + 1 };
}

/**
 * The index past a timestamp opening at `at`, or -1.
 *
 * A timestamp is a date, so it contributes nothing to read -- and its weekday
 * abbreviation is not a word anyone wrote.
 */
function timestampEnd(
	text: string,
	at: number,
	open: string,
	close: string,
): number {
	if (text[at] !== open) return -1;
	const end = text.indexOf(close, at + 1);
	if (end < 0) return -1;
	const body = text.slice(at + 1, end);
	return /^\d{4}-\d{2}-\d{2}(?:\s|$)/.test(body) ? end + 1 : -1;
}

function isSpace(c: string): boolean {
	return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function escapeHTML(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeAttr(s: string): string {
	return escapeHTML(s).replaceAll('"', "&#34;");
}
