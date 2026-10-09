/**
 * Reading QDoc, Qt's documentation markup.
 *
 * QDoc is LaTeX-style `\commands` inside `/*! ... *\/` comment blocks, in C++
 * sources or in standalone `.qdoc` files. There is no external converter: the
 * whole of it is here. See #784.
 *
 * Prose is kept word-for-word, so an alert can be located in the source by
 * search. Commands become the elements they mean -- sections are headings,
 * `\c` is a code span, `\note` is a classed div -- and topic or meta commands
 * are markup with nothing to lint. A command's machine-readable content, an
 * anchor's name or an image's file name, is written under the `meta` scope,
 * where a rule about naming can reach it and a style about prose cannot.
 */

import type { Config, File } from "@vale-ts/core";

/** What a QDoc reader needs from the linter. */
export interface QDocHost {
	config: Config;
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
	lintMetadata(f: File): void;
}

/**
 * The commands whose content runs to a matching `\end<X>` and is not prose.
 *
 * The command each one ends at is not always `\end<X>`: the code variants all
 * close on `\endcode`, and `\oldcode` runs through `\newcode` because both
 * halves are code.
 */
const VERBATIM: Readonly<Record<string, string>> = {
	badcode: "endcode",
	code: "endcode",
	css: "endcss",
	js: "endjs",
	newcode: "endcode",
	oldcode: "endcode",
	qml: "endqml",
	raw: "endraw",
};

/**
 * The topic, context, quoting, build-system and conditional commands whose
 * whole line is markup: identifiers, file paths, cross-references and
 * expressions, not prose.
 */
const SKIP_LINE = new Set([
	"abstract",
	"annotatedlist",
	"attribution",
	"class",
	"cmakecomponent",
	"cmakepackage",
	"cmaketargetitem",
	"codeline",
	"compares",
	"compareswith",
	"contentspage",
	"default",
	"dontdocument",
	"dots",
	"else",
	"endcompareswith",
	"endif",
	"enum",
	"example",
	"externalpage",
	"fn",
	"generatelist",
	"group",
	"headerfile",
	"if",
	"include",
	"indexpage",
	"inheaderfile",
	"ingroup",
	"inherits",
	"inmodule",
	"inqmlmodule",
	"instantiates",
	"internal",
	"macro",
	"meta",
	"module",
	"modulestate",
	"namespace",
	"nativetype",
	"nextpage",
	"noautolist",
	"nonreentrant",
	"notranslate",
	"omitvalue",
	"overload",
	"page",
	"preliminary",
	"previouspage",
	"printline",
	"printto",
	"printuntil",
	"property",
	"qmlabstract",
	"qmlattachedproperty",
	"qmlattachedsignal",
	"qmlbasictype",
	"qmlclass",
	"qmldefault",
	"qmlenum",
	"qmlenumeratorsfrom",
	"qmlmethod",
	"qmlmodule",
	"qmlproperty",
	"qmlsignal",
	"qmlsingletontype",
	"qmltype",
	"qmlvaluetype",
	"qtcmakepackage",
	"qtcmaketargetitem",
	"qtvariable",
	"quotefile",
	"quotefromfile",
	"readonly",
	"reentrant",
	"reimp",
	"relates",
	"required",
	"sa",
	"since",
	"sincelist",
	"skipline",
	"skipto",
	"skipuntil",
	"snippet",
	"startpage",
	"tableofcontents",
	"threadsafe",
	"toc",
	"tocentry",
	"typealias",
	"typedef",
	"variable",
	"wrapper",
]);

/**
 * The commands that open a classed paragraph -- prose a rule can target by
 * class -- running to the next blank line.
 */
const DIVS = new Set(["brief", "important", "note", "warning"]);

/** The inline commands, so one starting a line is not read as a block command. */
const INLINE_NAMES = new Set([
	"a",
	"b",
	"bold",
	"c",
	"e",
	"i",
	"l",
	"sub",
	"sup",
	"tt",
	"uicontrol",
	"underline",
]);

/** A block command at the start of a line: `\section1`, `\li`, `\endlist`. */
const RE_BLOCK_CMD = /^\s*\\([a-zA-Z0-9]+)\s*(.*)$/;

/**
 * An inline command and its argument: `\c word` or `\c {some words}`, with an
 * optional `[qualifier]` for `\l`. A braced argument may wrap within its
 * paragraph. `\\` is an escaped backslash, matched first so that the command
 * after one is read as text.
 */
const RE_INLINE_CMD =
	/\\\\|\\([a-zA-Z0-9]+)\s*(\[[^\]\n]*\]\s*)?(\{[^{}]*\}|[^\s{][^\s]*)?/d;

/** The braced `{text}` after a braced `\l` target or a `\span` attribute. */
const RE_LINK_TEXT = /^\s*\{[^{}]*\}/;
/** A `\div` or `\span` attribute list: `{class="header"}`. */
const RE_CLASS_ATTR = /class\s*=\s*"([^"]*)"/;
/** A table cell's `{rows,cols}` span, which precedes the cell's prose. */
const RE_CELL_SPAN = /^\{\d+\s*,\s*\d+\}\s*/;
/** The `[since]` qualifier that may open a `\deprecated` line. */
const RE_SINCE_QUAL = /^\[[^\]\n]*\]\s*/;
/** An HTML comment, which survives escaping. */
const RE_HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * The class named by a `\div` or `\span` attribute list, or the argument
 * itself when it is a bare name -- `\div {note}`.
 *
 * An unusable class is dropped rather than guessed at, leaving an unclassed
 * element.
 */
function qdocClass(argArg: string): string {
	const arg = qdocArg(argArg);
	const m = RE_CLASS_ATTR.exec(arg);
	if (m !== null) return m[1];
	if (/[='" ]/.test(arg)) return "";
	return arg;
}

/** Strips the braces from a command argument. */
function qdocArg(arg: string): string {
	if (arg.startsWith("{") && arg.endsWith("}")) {
		return arg.slice(1, -1).trim();
	}
	return arg;
}

function escapeAll(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Makes text safe to write into the HTML the walker reads.
 *
 * QDoc prose is kept word-for-word, and Qt's prose talks about markup: a
 * sentence explaining that a file "must be included using a `<script>` tag"
 * carries a real tag. Written straight through, it opens an element in the
 * converted document -- and `<script>` in particular puts the tokenizer into
 * raw-text mode, so the rest of the page is swallowed looking for a close
 * that never comes. The tokenizer decodes these again, so the text a rule
 * sees, and the text located in the source, are unchanged.
 *
 * An HTML comment is left alone: `vale off` and `vale on` reach the walker as
 * comments, and a QDoc file writes them the way any other markup does.
 */
export function qdocEsc(text: string): string {
	const spans = [...text.matchAll(RE_HTML_COMMENT)];
	if (spans.length === 0) return escapeAll(text);

	let out = "";
	let last = 0;
	for (const s of spans) {
		out += escapeAll(text.slice(last, s.index));
		out += s[0];
		last = s.index + s[0].length;
	}
	return out + escapeAll(text.slice(last));
}

/**
 * An image's file name, as metadata, marked `noalt` when nothing followed it.
 *
 * The file name is published either way, so a rule about naming still sees
 * every image. Dropping the node when alt text is present -- the obvious way
 * to make "image without alt text" detectable -- would have made naming rules
 * blind to exactly the images that are documented properly. A second class
 * says the same thing without taking anything away: `meta.class.image` is
 * every image, `meta.class.noalt` is the ones missing alt text. See #784.
 */
function imageMetaHTML(arg: string, rest: string): string {
	const file = qdocArg(arg);
	if (file === "") return "";

	// Whether an inline image has alt text is a softer question than for the
	// block form: `\inlineimage foo.png` sits mid-sentence, and the words
	// after it are as likely to be the rest of the sentence as a description.
	// Anything at all following the file name counts, so the reading errs
	// towards saying nothing.
	const cls = rest.trim() === "" ? "image noalt" : "image";
	return `<data class="${cls}">${qdocEsc(file)}</data>`;
}

/** The start and end of a capture group, or null when it did not participate. */
function group(m: RegExpExecArray, n: number): [number, number] | null {
	const indices = (
		m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }
	).indices;
	return indices?.[n] ?? null;
}

/**
 * Rewrites a line's inline commands.
 *
 * `\c` and `\a` become code spans, `\b` and friends keep their text in the
 * matching tag, `\l` keeps a link's text, and any other command is markup --
 * removed, with whatever followed it kept as prose.
 */
export function qdocInline(textArg: string): string {
	let text = textArg;
	let out = "";

	for (;;) {
		const m = RE_INLINE_CMD.exec(text);
		if (m === null) {
			out += qdocEsc(text);
			break;
		}

		const from = m.index;
		const to = m.index + m[0].length;
		out += qdocEsc(text.slice(0, from));

		const nameSpan = group(m, 1);
		if (nameSpan === null) {
			// `\\` is a literal backslash, not a command.
			out += "\\";
			text = text.slice(to);
			continue;
		}

		const name = text.slice(nameSpan[0], nameSpan[1]);
		const argSpan = group(m, 3);
		const arg = argSpan === null ? "" : text.slice(argSpan[0], argSpan[1]);
		let rest = text.slice(to);

		switch (name) {
			case "c":
			case "tt":
			case "a":
				out += `<code>${qdocEsc(qdocArg(arg))}</code>`;
				break;
			case "b":
			case "bold":
			case "uicontrol":
				out += `<strong>${qdocEsc(qdocArg(arg))}</strong>`;
				break;
			case "e":
			case "i":
				out += `<em>${qdocEsc(qdocArg(arg))}</em>`;
				break;
			case "underline":
				out += `<u>${qdocEsc(qdocArg(arg))}</u>`;
				break;
			case "sub":
			case "sup":
				out += `<${name}>${qdocEsc(qdocArg(arg))}</${name}>`;
				break;
			case "l": {
				let label = qdocArg(arg);
				if (arg.startsWith("{")) {
					const follow = RE_LINK_TEXT.exec(rest);
					if (follow !== null) {
						label = qdocArg(follow[0].trim());
						rest = rest.slice(follow[0].length);
					}
				}
				out += `<a href="#">${qdocEsc(label)}</a>`;
				break;
			}
			case "span": {
				// `\span {class="x"} {text}`: the attribute names a class a
				// rule can be scoped to, the braced text that follows is prose.
				let label = "";
				const follow = RE_LINK_TEXT.exec(rest);
				if (follow !== null) {
					label = qdocArg(follow[0].trim());
					rest = rest.slice(follow[0].length);
				}
				const cls = qdocClass(arg);
				out +=
					cls !== ""
						? `<span class="${cls}">${qdocEsc(label)}</span>`
						: `<span>${qdocEsc(label)}</span>`;
				break;
			}
			case "image":
			case "inlineimage":
				// The argument is a file name, published like the block form's
				// so that a rule about images sees inline ones too; a caption,
				// if any, stays in `rest` and is read as ordinary prose.
				out += imageMetaHTML(arg, rest);
				break;
			case "unicode":
				// The argument is a code point, not prose.
				break;
			default:
				// An unknown command is markup; whatever followed it is prose.
				rest = text.slice(nameSpan[1]);
				break;
		}

		text = rest;
	}

	return out;
}

/** One open `\list` or `\table`. */
interface Context {
	kind: "list" | "table";
	inItem: boolean;
	header: boolean;
}

/** Converts one QDoc document. */
class Converter {
	private html = "";
	private para: string[] = [];
	/** An open `\note` / `\brief` / ... paragraph's class. */
	private div = "";

	private stack: Context[] = [];
	/** The `\end` command that closes the open verbatim block. */
	private verbatim = "";
	private omitted = false;

	/**
	 * Whether the reader is inside a `/*! ... *\/` block, the only place QDoc
	 * looks. A comment body extracted from a source file starts inside one; a
	 * whole file starts outside.
	 */
	private inComment: boolean;

	constructor(inComment: boolean) {
		this.inComment = inComment;
	}

	result(): string {
		return this.html;
	}

	private flush(): void {
		if (this.para.length === 0) return;
		const text = qdocInline(this.para.join("\n"));
		this.para = [];

		if (this.stack[this.stack.length - 1]?.inItem === true) {
			this.html += `${text}\n`;
			return;
		}
		this.html += `<p>${text}</p>\n`;
	}

	/** Ends an open `\note`-style paragraph. */
	private closeDiv(): void {
		this.flush();
		if (this.div !== "") {
			this.html += "</div>\n";
			this.div = "";
		}
	}

	/** Writes a `<div>` carrying `arg`'s class, if it names one. */
	private openDiv(arg: string): void {
		this.flush();
		const cls = qdocClass(arg);
		this.html += cls !== "" ? `<div class="${cls}">\n` : "<div>\n";
	}

	private cellTag(top: Context): string {
		if (top.kind !== "table") return "li";
		return top.header ? "th" : "td";
	}

	/** Opens a `\li` -- a list item, or a table cell in the current row. */
	private item(restArg: string): void {
		const top = this.stack[this.stack.length - 1];
		if (top === undefined) {
			this.para.push(restArg);
			return;
		}

		this.endItem();
		top.inItem = true;

		// A table cell may open with a `{rows,cols}` span, which is markup.
		const rest = restArg.replace(RE_CELL_SPAN, "");

		this.html += `<${this.cellTag(top)}>`;
		if (rest !== "") this.para.push(rest);
	}

	private endItem(): void {
		const top = this.stack[this.stack.length - 1];
		if (top === undefined || !top.inItem) return;
		this.flush();
		this.html += `</${this.cellTag(top)}>\n`;
		top.inItem = false;
	}

	/**
	 * Whether `name` closes the open verbatim block.
	 *
	 * Both the command QDoc documents and the symmetrical `\end<X>` are
	 * accepted, so a source that writes `\endbadcode` is not read as
	 * unterminated.
	 */
	private endsVerbatim(name: string): boolean {
		return name === VERBATIM[this.verbatim] || name === `end${this.verbatim}`;
	}

	/**
	 * Reads one line of a QDoc source, tracking which lines the reader is
	 * meant to see at all.
	 *
	 * QDoc documents a project from its `/*! ... *\/` comments and nothing
	 * else. A `.qdoc` file is a file of those comments, and what sits between
	 * them -- a licence header, a `//! [name]` snippet whose body is shell or
	 * C++ -- is no more prose than the code in a `.cpp` file is.
	 */
	line(raw: string): void {
		const closes = raw.trim().endsWith("*/");

		// A verbatim or omitted block cannot outlive the comment holding it.
		// An unterminated one -- a `\code` whose `\endcode` was never written,
		// or a spelling this converter does not know -- would otherwise
		// swallow the rest of the file.
		if (closes) {
			if (this.verbatim !== "") {
				this.html += "</code></pre>\n";
				this.verbatim = "";
			}
			this.omitted = false;
		}

		if (this.inComment || opensComment(raw)) {
			this.inComment = true;
			this.content(blankDelims(raw));
		}

		if (closes) {
			this.inComment = false;
			this.closeDiv();
		}
	}

	/** Reads one line of a comment's body. */
	content(raw: string): void {
		const trimmed = raw.trim();

		if (this.verbatim !== "") {
			const m = RE_BLOCK_CMD.exec(raw);
			if (m !== null && this.endsVerbatim(m[1])) {
				this.verbatim = "";
				this.html += "</code></pre>\n";
			}
			// The content itself is dropped: it was never prose.
			return;
		}
		if (this.omitted) {
			const m = RE_BLOCK_CMD.exec(raw);
			if (m !== null && m[1] === "endomit") this.omitted = false;
			return;
		}

		// A `//` line inside a comment is a snippet marker -- `//! [intro]` --
		// or code, never prose. QDoc renders nothing for it, so it does not
		// end the paragraph it sits in the middle of either.
		if (trimmed.startsWith("//")) return;

		if (trimmed === "") {
			this.closeDiv();
			this.flush();
			return;
		}

		const m = RE_BLOCK_CMD.exec(raw);
		if (m === null) {
			this.para.push(raw);
			return;
		}

		const name = m[1];
		const rest = m[2].trim();
		if (INLINE_NAMES.has(name)) {
			this.para.push(raw);
			return;
		}

		this.command(name, rest);
	}

	private command(name: string, restArg: string): void {
		let rest = restArg;

		if (name === "omit") {
			this.flush();
			// An omission closed on its own line, `\omit x \endomit`, ends
			// there, and any prose after it is a paragraph of its own.
			const at = rest.indexOf("\\endomit");
			if (at >= 0) {
				const after = rest.slice(at + "\\endomit".length).trim();
				if (after !== "") this.para.push(after);
			} else {
				this.omitted = true;
			}
			return;
		}
		if (name in VERBATIM) {
			this.flush();
			this.verbatim = name;
			this.html += "<pre><code>";
			return;
		}
		if (SKIP_LINE.has(name)) {
			this.flush();
			return;
		}
		if (DIVS.has(name)) {
			this.closeDiv();
			this.div = name;
			this.html += `<div class="${name}">\n`;
			if (rest !== "") this.para.push(rest);
			return;
		}
		if (
			name.startsWith("section") &&
			name.length === 8 &&
			name[7] >= "1" &&
			name[7] <= "4"
		) {
			// `\section1` is the first level *under* the page's title, so it is
			// an `h2`; the title itself is the `h1`.
			this.closeDiv();
			const level = Number(name[7]) + 1;
			this.html += `<h${level}>${qdocInline(rest)}</h${level}>\n`;
			return;
		}

		switch (name) {
			case "title":
				this.flush();
				this.html += `<h1>${qdocInline(rest)}</h1>\n`;
				return;
			case "subtitle":
				this.flush();
				this.html += `<h2 class="subtitle">${qdocInline(rest)}</h2>\n`;
				return;
			case "deprecated":
				// `\deprecated [6.0] Use \l Foo instead.`: the version is
				// markup, the replacement advice that may follow it is prose.
				this.flush();
				rest = rest.replace(RE_SINCE_QUAL, "");
				if (rest !== "") this.para.push(rest);
				return;
			case "list":
				this.flush();
				this.stack.push({ kind: "list", inItem: false, header: false });
				this.html += "<ul>\n";
				return;
			case "endlist":
				this.endItem();
				this.stack.pop();
				this.html += "</ul>\n";
				return;
			case "table":
				this.flush();
				this.stack.push({ kind: "table", inItem: false, header: false });
				this.html += "<table>\n";
				return;
			case "endtable":
				this.endItem();
				this.stack.pop();
				this.html += "</table>\n";
				return;
			case "header":
			case "row": {
				this.endItem();
				const top = this.stack[this.stack.length - 1];
				if (top !== undefined) top.header = name === "header";
				this.html += "<tr>\n";
				return;
			}
			case "li":
			case "o":
				this.item(rest);
				return;
			case "value": {
				// `\value ConstantName The description is prose.`
				this.flush();
				const fields = rest.split(/\s+/).filter((x) => x !== "");
				if (fields.length > 1) {
					this.html += `<p><code>${qdocEsc(fields[0])}</code> ${qdocInline(
						fields.slice(1).join(" "),
					)}</p>\n`;
				}
				return;
			}
			case "quotation":
				this.flush();
				this.html += "<blockquote>\n";
				return;
			case "endquotation":
				this.flush();
				this.html += "</blockquote>\n";
				return;
			case "div":
				this.openDiv(rest);
				return;
			case "details": {
				// `\details {Summary text}`: the summary is prose of its own.
				this.flush();
				this.html += '<div class="details">\n';
				const summary = qdocArg(rest);
				if (summary !== "") {
					this.html += `<p class="summary">${qdocInline(summary)}</p>\n`;
				}
				return;
			}
			case "enddiv":
			case "enddetails":
				this.flush();
				this.html += "</div>\n";
				return;
			case "legalese":
				this.flush();
				this.html += '<div class="legalese">\n';
				return;
			case "endlegalese":
				this.flush();
				this.html += "</div>\n";
				return;
			case "caption":
				this.flush();
				this.html += `<figcaption>${qdocInline(rest)}</figcaption>\n`;
				return;
			case "target":
			case "keyword":
				// The anchor a link points at: a name, reachable under `meta`
				// for a rule about naming and invisible to one about prose.
				this.flush();
				this.meta("anchor", qdocArg(rest));
				return;
			case "image":
			case "inlineimage": {
				// `\image file.png An optional caption of prose.`
				this.flush();
				const fields = rest.split(/\s+/).filter((x) => x !== "");
				if (fields.length === 1) this.meta("image", fields[0], "noalt");
				else if (fields.length > 1) this.meta("image", fields[0]);
				if (fields.length > 1) {
					this.html += `<figcaption>${qdocInline(
						fields.slice(1).join(" "),
					)}</figcaption>\n`;
				}
				return;
			}
			default:
				// An unknown block command: the command is markup, the rest
				// prose.
				if (rest !== "") this.para.push(rest);
				return;
		}
	}

	/**
	 * Writes one piece of the document's machine-readable content -- an anchor
	 * name, an image's file name -- under the `meta` scope.
	 */
	private meta(kind: string, value: string, extra?: string): void {
		if (value === "") return;
		const cls = extra === undefined ? kind : `${kind} ${extra}`;
		this.html += `<data class="${cls}">${qdocEsc(value)}</data>\n`;
	}

	/** Finishes the document. */
	end(): void {
		this.closeDiv();
		this.flush();
	}
}

/**
 * Blanks the comment delimiters of a standalone `.qdoc` file, which a command
 * or its prose may share a line with: `/*! \page index.html`.
 *
 * They are replaced by spaces rather than removed so that a column in the
 * converted line is still a column in the source.
 */
function blankDelims(rawArg: string): string {
	let raw = rawArg;
	const open = raw.indexOf("/*!");
	if (open >= 0 && raw.slice(0, open).trim() === "") {
		raw = `${raw.slice(0, open)}   ${raw.slice(open + 3)}`;
	}
	const close = raw.lastIndexOf("*/");
	if (close >= 0 && raw.slice(close + 2).trim() === "") {
		raw = `${raw.slice(0, close)}  ${raw.slice(close + 2)}`;
	}
	return raw;
}

/** Whether the line starts a `/*!` documentation comment. */
function opensComment(raw: string): boolean {
	const at = raw.indexOf("/*!");
	return at >= 0 && raw.slice(0, at).trim() === "";
}

function convert(content: string, inComment: boolean): string {
	const conv = new Converter(inComment);
	for (const line of content.split("\n")) conv.line(line);
	conv.end();
	return conv.result();
}

/**
 * Converts a whole QDoc source: the `/*! ... *\/` comments in it are the
 * document, and everything else is code.
 */
export function qdocToHTML(content: string): string {
	return convert(content, false);
}

/**
 * Converts the body of a single comment, already extracted from a source
 * file, so there is no `/*!` left to wait for.
 */
export function qdocFragmentToHTML(content: string): string {
	return convert(content, true);
}

/**
 * Reads a QDoc source.
 *
 * A `.qdocinc` is the exception. It is an include -- the body of a comment,
 * pulled into a document by `\include` -- so its markup is not wrapped in
 * `/*! ... *\/`, and reading it as a `.qdoc` file leaves the whole thing
 * unread while waiting for a comment to open. Starting inside one reads both
 * shapes: a `/*!` still opens a comment where the file writes one. See #784.
 */
export function lintQDoc(host: QDocHost, f: File): void {
	if (f.realExt === ".qdocinc") {
		lintQDocWith(host, f, qdocFragmentToHTML);
		return;
	}
	lintQDocWith(host, f, qdocToHTML);
}

/** Reads one QDoc comment lifted out of a code file. */
export function lintQDocFragment(host: QDocHost, f: File): void {
	lintQDocWith(host, f, qdocFragmentToHTML);
}

function lintQDocWith(
	host: QDocHost,
	f: File,
	convertWith: (s: string) => string,
): void {
	host.lintMetadata(f);
	const s = host.transform(f);
	host.lintHTMLTokens(f, convertWith(s), 0);
}
