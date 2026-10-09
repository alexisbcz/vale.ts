/**
 * Reading MDX: CommonMark plus ESM statements, JSX elements, and JavaScript
 * expressions.
 *
 * The JavaScript -- ESM, expressions, tags and their attributes, self-closing
 * elements -- holds no prose and renders as inline or fenced code, which the
 * walker skips. A JSX element's children are Markdown, though, just as MDX
 * itself reads them: a flow element becomes a div classed with the element's
 * name, so its content is linted and a rule can reach (or a user can ignore)
 * it by class, and an inline element becomes a span the same way. A
 * `{/* ... *\/}` flow comment becomes an HTML comment instead, so
 * comment-based configuration keeps working.
 *
 * # Scanning, not parsing
 *
 * The JavaScript is scanned rather than parsed: one depth per kind of
 * bracket, with strings, template literals and comments recognized so that a
 * bracket inside them does not count. It is an approximation -- a regular
 * expression literal holding a bracket would fool it -- but it covers the
 * JavaScript that appears in documentation, and a scanner cannot fail on code
 * it does not understand.
 *
 * # Masking
 *
 * An alert is placed by searching the source for its text, and a JSX tag is
 * the one piece of source the walker never sees -- so its attributes are
 * still there to be found unless they are blanked.
 *
 * The tags are found by a scan of their own (`jsxTagSpans`) rather than
 * collected while parsing. Go collects them from the parsed tree, which it can
 * because goldmark's nodes carry ranges into the source; markdown-it parses
 * inline content out of a detached string, so an inline rule has no way to say
 * where in the document it is. A tag is exactly what `opensJsx` and `tagEnd`
 * recognize, so looking for them directly finds the same ranges -- a code
 * fence aside, whose contents the walker skips anyway and which the scan
 * therefore steps over.
 *
 * # Indentation
 *
 * MDX removed indented code from the grammar, so four spaces are whitespace
 * rather than a code block, and every other block can open behind them. The
 * `code` rule is switched off and `mdx_indent` takes its place: it raises the
 * block indent to the line's own and parses the rest from there.
 */

import type { Config, File } from "@vale-ts/core";
import { newE201FromPosition } from "@vale-ts/core";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import htmlBlock from "markdown-it/lib/rules_block/html_block.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import { mathPlugin } from "./math.ts";
import { prepMarkdown } from "./md.ts";

/** What an MDX reader needs from the linter. */
export interface MDXHost {
	config: Config;
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
	lintMetadata(f: File): void;
}

/** A source range with no prose in it. */
export type Span = [number, number];

/** What a parse records on the side. */
interface MDXEnv {
	/** Where the first block the document left open began, and what it was. */
	mdxUnclosed?: { offset: number; what: string };
}

// --- scanning JavaScript ----------------------------------------------------

function isSpace(c: string): boolean {
	return (
		c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r"
	);
}

function isIdent(c: string): boolean {
	return (
		c === "_" ||
		c === "$" ||
		(c >= "0" && c <= "9") ||
		(c >= "a" && c <= "z") ||
		(c >= "A" && c <= "Z")
	);
}

/**
 * Whether `c` can appear in a JSX element name.
 *
 * Member expressions (`myComponents.thisOne`) are allowed, and -- at the start
 * -- a fragment's empty name.
 */
export function isTagName(c: string): boolean {
	return (
		c === "." ||
		c === "-" ||
		c === "_" ||
		c === "$" ||
		(c >= "0" && c <= "9") ||
		(c >= "a" && c <= "z") ||
		(c >= "A" && c <= "Z")
	);
}

/** Whether `rest`, which begins with `<`, opens an element or a fragment. */
function jsxStarts(rest: string): boolean {
	if (rest.length < 2) return false;
	const c = rest[1];
	return (
		c === ">" ||
		c === "_" ||
		c === "$" ||
		(c >= "a" && c <= "z") ||
		(c >= "A" && c <= "Z")
	);
}

/**
 * Tracks nesting through JavaScript-ish source: one depth for every kind of
 * bracket, with strings, template literals and comments recognized.
 */
class Scan {
	depth = 0;
	/** `'`, `"`, `` ` `` or "". */
	quote = "";
	/** Inside a `/* ... *\/` comment. */
	comment = false;

	/**
	 * An element inside the expression, until it completes. Its text is prose,
	 * where a quote or a bracket means nothing.
	 */
	jsx: JsxScan | null = null;

	/** The last character outside a string or comment. */
	prev = "";
	/** The identifier `prev` ends; the two say whether a `<` can begin an element. */
	word = "";

	constructor(depth = 0) {
		this.depth = depth;
	}

	clone(): Scan {
		const t = new Scan(this.depth);
		t.quote = this.quote;
		t.comment = this.comment;
		t.prev = this.prev;
		t.word = this.word;
		t.jsx = this.jsx === null ? null : this.jsx.clone();
		return t;
	}

	/** Processes one line. */
	scan(line: string): void {
		this.walk(line, false);
	}

	/**
	 * Processes one line of a `{...}` expression, stopping once it closes, and
	 * returns the index just past the closing brace, or -1.
	 */
	scanExpr(line: string): number {
		return this.walk(line, true);
	}

	private walk(line: string, expr: boolean): number {
		for (let i = 0; i < line.length; i++) {
			const c = line[i];

			if (this.jsx !== null) {
				const n = this.jsx.scan(line.slice(i));
				if (!this.jsx.done) return -1;
				this.jsx = null;
				this.note(">");
				i += n - 1;
				continue;
			}
			if (this.comment) {
				if (c === "*" && line[i + 1] === "/") {
					this.comment = false;
					i++;
				}
				continue;
			}
			if (this.quote !== "") {
				if (c === "\\") i++;
				else if (c === this.quote) {
					this.quote = "";
					this.note(c);
				}
				continue;
			}

			switch (c) {
				case "'":
				case '"':
				case "`":
					this.quote = c;
					continue;
				case "/":
					if (i + 1 < line.length) {
						if (line[i + 1] === "*") {
							this.comment = true;
							i++;
							continue;
						}
						if (line[i + 1] === "/") return -1; // a line comment runs to the end
					}
					break;
				case "<":
					if (this.jsxCanStart() && jsxStarts(line.slice(i))) {
						this.jsx = new JsxScan();
						const n = this.jsx.scan(line.slice(i));
						if (!this.jsx.done) return -1;
						this.jsx = null;
						this.note(">");
						i += n - 1;
						continue;
					}
					break;
				case "{":
				case "(":
				case "[":
					this.depth++;
					break;
				case "}":
				case ")":
				case "]":
					this.depth--;
					if (expr && this.depth <= 0) return i + 1;
					break;
				default:
					break;
			}
			this.note(c);
		}
		return -1;
	}

	/** Records `c` as the last significant character. */
	private note(c: string): void {
		if (isSpace(c)) return;
		this.prev = c;
		this.word = isIdent(c) ? this.word + c : "";
	}

	/**
	 * Whether a `<` here begins an element rather than a comparison or a type
	 * argument: at the start of the expression, after a character no operand
	 * ends with, or after a keyword an expression follows.
	 */
	private jsxCanStart(): boolean {
		if (this.prev === "" || "{([,=:?&|!>;".includes(this.prev)) return true;
		return this.word === "return" || this.word === "yield" || this.word === "await";
	}
}

/**
 * Walks a JSX element to its end.
 *
 * Tags are pushed and popped, and `{...}` expressions -- in attributes or in
 * children -- are handed to a `Scan` so their contents cannot end a tag or the
 * element.
 */
class JsxScan {
	stack: string[] = [];

	/** 0 children text, 1 inside a tag's name or attributes, 2 an expression. */
	mode = 0;

	js = new Scan();

	/**
	 * Whether the active expression began inside a tag, so its end returns the
	 * scan to the right mode.
	 */
	wasInTag = false;

	/** The tag being read. */
	name = "";
	/** The name is complete. */
	named = false;
	/** The tag is `</...>`. */
	closing = false;
	/** The tag ends with `/>`. */
	selfEnd = false;
	/** Inside an attribute string. */
	quote = "";

	/** At least one tag has been read. */
	begun = false;
	/** The element is complete. */
	done = false;

	clone(): JsxScan {
		const t = new JsxScan();
		t.stack = [...this.stack];
		t.mode = this.mode;
		t.js = this.js.clone();
		t.wasInTag = this.wasInTag;
		t.name = this.name;
		t.named = this.named;
		t.closing = this.closing;
		t.selfEnd = this.selfEnd;
		t.quote = this.quote;
		t.begun = this.begun;
		t.done = this.done;
		return t;
	}

	/**
	 * Processes one line of the element and returns how much of it was read:
	 * all of it, or up to where the element completed.
	 */
	scan(line: string): number {
		for (let i = 0; i < line.length; i++) {
			const c = line[i];

			if (this.mode === 2) {
				// The expression scanner reads the rest of the line, so an
				// escape or a line comment is seen whole; its depth began at 1
				// for the opening brace.
				const end = this.js.scanExpr(line.slice(i));
				if (end < 0) return line.length;
				i += end - 1;
				this.mode = this.wasInTag ? 1 : 0;
			} else if (this.mode === 1) {
				if (this.quote !== "") {
					if (c === this.quote) this.quote = "";
					continue;
				}
				if (!this.named && isTagName(c)) {
					this.name += c;
				} else if (!this.named) {
					this.named = true;
					i--; // reprocess as an attribute character
				} else if (c === "'" || c === '"') {
					this.quote = c;
				} else if (c === "{") {
					this.js = new Scan(1);
					this.wasInTag = true;
					this.mode = 2;
				} else if (c === "/") {
					this.selfEnd = true;
				} else if (c === ">") {
					this.endTag();
				}
				// anything else is an attribute character
			} else {
				if (c === "<") {
					this.mode = 1;
					this.name = "";
					this.named = false;
					this.closing = false;
					this.selfEnd = false;
					if (line[i + 1] === "/") {
						this.closing = true;
						i++;
					}
				} else if (c === "{") {
					this.js = new Scan(1);
					this.wasInTag = false;
					this.mode = 2;
				}
			}

			if (this.done) return i + 1;
		}
		return line.length;
	}

	private endTag(): void {
		if (this.closing) {
			this.stack.pop();
		} else if (!this.selfEnd) {
			this.stack.push(this.name);
		}
		// A self-closing tag opens and closes at once.

		this.begun = true;
		this.mode = 0;
		if (this.stack.length === 0) this.done = true;
	}
}

/**
 * The offset just past the line's first completed tag, scanning from the
 * carried state, or -1 when the tag needs more lines.
 *
 * On success the carried state is advanced to that offset. The scan reads a
 * character ahead of itself (`</`, `/*`), so each prefix is probed whole from
 * a copy rather than a character at a time.
 */
function tagEnd(line: string, carried: JsxScan): number {
	for (let i = 1; i <= line.length; i++) {
		const t = carried.clone();
		t.scan(line.slice(0, i));
		if (t.begun && t.mode === 0) {
			copyInto(carried, t);
			return i;
		}
	}
	return -1;
}

function copyInto(dst: JsxScan, src: JsxScan): void {
	dst.stack = src.stack;
	dst.mode = src.mode;
	dst.js = src.js;
	dst.wasInTag = src.wasInTag;
	dst.name = src.name;
	dst.named = src.named;
	dst.closing = src.closing;
	dst.selfEnd = src.selfEnd;
	dst.quote = src.quote;
	dst.begun = src.begun;
	dst.done = src.done;
}

/**
 * Whether `line` at `pos` begins a JSX tag: `<` followed by a name, a
 * fragment's `>`, or a closing `/`.
 *
 * `<!`, `<?`, and autolink-style `<scheme:` starts are left to other rules.
 */
export function opensJsx(line: string, pos: number): boolean {
	if (pos >= line.length || line[pos] !== "<") return false;
	const rest = line.slice(pos + 1);
	if (rest.length === 0) return false;
	if (rest[0] === ">" || rest[0] === "/") return true;
	if (!isTagName(rest[0])) return false;
	// A scheme (`https:`) or an email (`user@host`) means an autolink.
	for (const c of rest) {
		if (c === " " || c === "\t" || c === ">" || c === "/" || c === "\n" || c === "{") {
			return true;
		}
		if (!isTagName(c)) return false;
	}
	return true;
}

/** Whether `rest` holds text outside its tags and expressions. */
function hasText(rest: string): boolean {
	for (let i = 0; i < rest.length; ) {
		if (rest[i] === "<") {
			const end = tagEnd(rest.slice(i), new JsxScan());
			if (end < 0) return false;
			i += end;
		} else if (rest[i] === "{") {
			const n = new Scan().scanExpr(rest.slice(i));
			if (n < 0) return false;
			i += n;
		} else if (!isSpace(rest[i])) {
			return true;
		} else {
			i++;
		}
	}
	return false;
}

/** Whether the element completes in the rest of its first line. */
function doneOnLine(s: JsxScan, rest: string): boolean {
	const t = s.clone();
	t.scan(rest);
	return t.done;
}

/** Whether `line` is exactly a closing tag for `name`. */
function isCloseTag(line: string, name: string): boolean {
	if (!line.startsWith("</")) return false;
	let rest = line.slice(2);
	if (!rest.startsWith(name)) return false;
	rest = rest.slice(name.length).replace(/^[ \t]+/, "");
	return rest === ">";
}

/**
 * The name's tags opened minus closed on a child line, so a same-name element
 * handled by a descendant is not mistaken for this one's close.
 *
 * It reads one line at a time -- a tag broken across lines or a `>` quoted in
 * an attribute can miscount -- which covers the JSX that appears in
 * documentation.
 */
function netOpens(line: string, name: string): number {
	if (name === "") return 0;

	let net = 0;
	for (let i = 0; i + 1 < line.length; i++) {
		if (line[i] !== "<") continue;
		let j = i + 1;
		const closing = line[j] === "/";
		if (closing) j++;
		if (!line.startsWith(name, j)) continue;
		const k = j + name.length;
		if (k < line.length && isTagName(line[k])) continue; // a longer name
		if (closing) {
			net--;
			continue;
		}
		const end = line.indexOf(">", k);
		if (end < 0) net++; // the tag spans lines
		else if (end === k || line[end - 1] !== "/") net++;
	}
	return net;
}

/** Whether `source` is a `{/* ... *\/}` comment. */
function isComment(source: string): boolean {
	return source.startsWith("{/*") && source.endsWith("*/}");
}

/**
 * Renders an element name as a class.
 *
 * A member expression's dots become hyphens, since a dot separates the parts
 * of a scope.
 */
export function className(name: string): string {
	return name.replaceAll(".", "-");
}

/**
 * The source ranges of the JSX tags in `content`.
 *
 * A fenced code block is stepped over: what is inside one is not JSX, and the
 * walker skips it in any case. Everything else is scanned straight through, so
 * a tag that spans lines is found whole.
 */
export function jsxTagSpans(content: string): Span[] {
	const spans: Span[] = [];
	const lines = content.split("\n");

	let at = 0;
	let fenced = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			fenced = !fenced;
			at += line.length + 1;
			continue;
		}
		if (fenced) {
			at += line.length + 1;
			continue;
		}

		for (let i = 0; i < line.length; i++) {
			if (line[i] !== "<") continue;
			if (!opensJsx(line, i)) continue;
			// From the rest of the document, not the rest of the line: an open
			// tag may carry its attributes over several lines.
			const rest = content.slice(at + i);
			const end = tagEnd(rest, new JsxScan());
			if (end < 0) continue;
			spans.push([at + i, at + i + end]);
			if (at + i + end > at + line.length) {
				// The tag ran past this line; the lines it covers are handled by
				// the span, so the scan resumes after it.
				i = line.length;
			} else {
				i += end - 1;
			}
		}

		at += line.length + 1;
	}

	return spans;
}

/** Blanks the given ranges of `content`, character for character, keeping newlines. */
export function maskSpans(content: string, spans: readonly Span[]): string {
	if (spans.length === 0) return content;
	const b = [...content];
	for (const [from, to] of spans) {
		for (let i = Math.max(from, 0); i < to && i < b.length; i++) {
			if (b[i] !== "\n") b[i] = " ";
		}
	}
	return b.join("");
}

// --- the markdown-it rules --------------------------------------------------

/** The raw text of a line, with the newline the scanners expect. */
function rawLine(state: StateBlock, line: number): string {
	return `${state.src.slice(state.bMarks[line], state.eMarks[line])}\n`;
}

function envOf(state: { env: unknown }): MDXEnv {
	return state.env as MDXEnv;
}

/**
 * Records where a block the document left open began.
 *
 * The rest of a file after such a block is read as code, so none of it would
 * be checked; MDX itself rejects the file, and so does Vale.
 */
function noteUnclosed(state: { env: unknown }, offset: number, what: string): void {
	const env = envOf(state);
	env.mdxUnclosed ??= { offset, what };
}

const RE_ESM = /^(?:import|export)\b/;

/** Whether a scan has nothing left open. */
function settled(s: Scan): boolean {
	return s.depth <= 0 && !s.comment && s.quote === "";
}

/**
 * Reads a block of `import`/`export` statements.
 *
 * Contiguous statements are one node, matching how MDX reads them.
 */
function mdxEsm(
	state: StateBlock,
	startLine: number,
	endLine: number,
	silent: boolean,
): boolean {
	if (state.tShift[startLine] !== 0) return false;
	const first = rawLine(state, startLine);
	if (!RE_ESM.test(first)) return false;
	if (silent) return true;

	let scan = new Scan();
	scan.scan(first);
	let finished = settled(scan);

	const held = [first];
	let nextLine = startLine + 1;
	for (; nextLine < endLine; nextLine++) {
		const line = rawLine(state, nextLine);
		if (finished) {
			// Another statement directly below joins the block.
			if (!RE_ESM.test(line)) break;
			scan = new Scan();
		}
		scan.scan(line);
		finished = settled(scan);
		held.push(line);
	}

	pushBlock(state, "mdxjsEsm", held.join(""), startLine, nextLine);
	state.line = nextLine;
	return true;
}

/** Reads a `{...}` expression standing on its own. */
function mdxFlowExpr(
	state: StateBlock,
	startLine: number,
	endLine: number,
	silent: boolean,
): boolean {
	const pos = state.tShift[startLine];
	const first = rawLine(state, startLine);
	if (first[pos] !== "{") return false;

	const scan = new Scan();
	let end = scan.scanExpr(first.slice(pos));
	if (end >= 0 && first.slice(pos + end).trim() !== "") {
		// Prose follows on the line: a text expression in a paragraph.
		return false;
	}
	if (silent) return true;

	let finished = end >= 0;
	const held = [first];
	let nextLine = startLine + 1;
	for (; nextLine < endLine && !finished; nextLine++) {
		const line = rawLine(state, nextLine);
		end = scan.scanExpr(line);
		finished = end >= 0;
		held.push(line);
	}

	if (!finished) {
		noteUnclosed(
			state,
			state.bMarks[startLine] + pos,
			"the expression opened here never closes",
		);
	}

	pushBlock(state, "mdxFlowExpression", held.join(""), startLine, nextLine);
	state.line = nextLine;
	return true;
}

/** Pushes a node that renders as code, or as a comment. */
function pushBlock(
	state: StateBlock,
	typ: string,
	text: string,
	startLine: number,
	endLine: number,
): void {
	const token = state.push("mdx_block", "code", 0);
	token.block = true;
	token.content = text.replace(/\n+$/, "");
	token.meta = { typ };
	token.map = [startLine, endLine];
}

/**
 * Reads a block-level JSX element.
 *
 * An element opened and closed on one line -- self-closing or otherwise -- is
 * a code node. An element with lines of its own is a container whose children
 * keep parsing as Markdown.
 */
function mdxJsxFlow(
	state: StateBlock,
	startLine: number,
	endLine: number,
	silent: boolean,
): boolean {
	const pos = state.tShift[startLine];
	const first = rawLine(state, startLine);
	if (!opensJsx(first, pos)) return false;

	const begin = state.bMarks[startLine];
	const scan = new JsxScan();
	const end = tagEnd(first.slice(pos), scan);

	if (end >= 0 && (scan.done || doneOnLine(scan, first.slice(pos + end)))) {
		if (hasText(first.slice(pos + end))) {
			// Text beside the tags: MDX reads the line as a paragraph holding
			// an inline element, so its text is prose.
			return false;
		}
		if (silent) return true;
		// The whole element sits on this line with nothing to lint.
		pushBlock(state, "mdxJsxFlowElement", first, startLine, startLine + 1);
		state.line = startLine + 1;
		return true;
	}

	if (silent) return true;

	let name: string;
	let open = startLine;

	if (end < 0) {
		// The open tag itself spans lines.
		scan.scan(first.slice(pos));
		let line = startLine + 1;
		for (; line < endLine; line++) {
			const text = rawLine(state, line);
			if (tagEnd(text, scan) < 0) {
				scan.scan(text);
				continue;
			}
			break;
		}

		if (line >= endLine) {
			// The tag never ends.
			noteUnclosed(state, begin + pos, "the tag opened here never ends");
			state.line = endLine;
			return true;
		}

		if (scan.done) {
			// Childless after all: a multiline self-closing element. It is tags
			// and nothing else, so it renders as nothing, like a container's
			// tags: its source is masked out of the search context, and the
			// walker must not then look for it there -- which moved every later
			// match and lost the alerts whose words the element also held.
			state.line = line + 1;
			return true;
		}

		name = scan.stack[scan.stack.length - 1];
		open = line;
	} else {
		name = scan.stack[scan.stack.length - 1];
	}

	// The element's children run to its matching close tag, counting
	// same-name elements a descendant handles and ignoring JSX quoted in a
	// code fence.
	let depth = 0;
	let fenced = false;
	let close = -1;
	for (let line = open + 1; line < endLine; line++) {
		const text = rawLine(state, line);
		const trimmed = text.trim();

		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		if (isCloseTag(trimmed, name)) {
			if (depth === 0) {
				close = line;
				break;
			}
			depth--;
			continue;
		}
		depth += netOpens(text, name);
	}

	const last = close < 0 ? endLine : close;

	const openToken = state.push("mdx_container_open", "div", 1);
	openToken.block = true;
	openToken.meta = { name };
	openToken.map = [open, last];

	// The children are Markdown. The block indent is the element's own, so a
	// fence indented under it is still a fence and not an indented paragraph.
	const oldMax = state.lineMax;
	const oldIndent = state.blkIndent;
	state.lineMax = last;
	state.blkIndent = state.sCount[startLine];
	state.md.block.tokenize(state, open + 1, last);
	state.lineMax = oldMax;
	state.blkIndent = oldIndent;

	const closeToken = state.push("mdx_container_close", "div", -1);
	closeToken.block = true;

	state.line = close < 0 ? last : close + 1;
	return true;
}

/**
 * Parses a block at four or more columns of indentation.
 *
 * MDX removed indented code from the grammar, so the indentation is
 * whitespace and whatever follows it is an ordinary block. Raising the block
 * indent to the line's own is what lets every other rule see it: they all
 * decline a line indented four columns past their parent.
 */
function mdxIndent(
	state: StateBlock,
	startLine: number,
	endLine: number,
	silent: boolean,
): boolean {
	if (silent) return false;
	if (state.sCount[startLine] - state.blkIndent < 4) return false;
	if (state.isEmpty(startLine)) return false;

	const old = state.blkIndent;
	state.blkIndent = state.sCount[startLine];
	state.md.block.tokenize(state, startLine, endLine);
	state.blkIndent = old;
	return true;
}

/**
 * An inline expression, or one tag of a JSX element.
 *
 * An element's children are left inline, so they keep parsing as prose; only
 * the tag itself becomes a node, rendered as a span so the element's name
 * reaches rules as a class.
 */
function mdxInline(state: StateInline, silent: boolean): boolean {
	const src = state.src;
	const start = state.pos;
	const c = src[start];
	if (c !== "{" && c !== "<") return false;

	if (c === "<" && !opensJsx(src, start)) return false;

	const limit = state.posMax;
	if (c === "{") {
		const used = new Scan().scanExpr(src.slice(start, limit));
		if (used < 0) return false;
		if (!silent) {
			const text = src.slice(start, start + used);
			const token = state.push("mdx_inline", "code", 0);
			token.content = text;
			token.meta = { typ: "mdxTextExpression", form: 0, name: "" };
		}
		state.pos = start + used;
		return true;
	}

	const jsx = new JsxScan();
	const used = tagEnd(src.slice(start, limit), jsx);
	if (used < 0) return false;

	if (!silent) {
		const text = src.slice(start, start + used);
		let form = 0;
		let name = "";
		if (text.startsWith("</")) form = 2;
		else if (!jsx.done) {
			form = 1;
			name = jsx.stack[jsx.stack.length - 1];
		}

		const token = state.push("mdx_inline", "span", 0);
		token.content = text;
		token.meta = { typ: "mdxJsxTextElement", form, name };
	}

	state.pos = start + used;
	return true;
}

// --- rendering --------------------------------------------------------------

function escapeHTML(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function renderBlock(tokens: Token[], idx: number): string {
	const token = tokens[idx];
	const typ = (token.meta as { typ: string }).typ;
	const src = token.content;

	if (typ === "mdxFlowExpression" && isComment(src)) {
		return `<!--${src.slice(3, -3)}-->\n`;
	}
	if (src.includes("\n")) {
		return `<pre><code class="mdxNode ${typ}">${escapeHTML(src)}</code></pre>\n`;
	}
	return `<code class="mdxNode ${typ}">${escapeHTML(src)}</code>\n`;
}

function renderInline(tokens: Token[], idx: number): string {
	const token = tokens[idx];
	const meta = token.meta as { typ: string; form: number; name: string };

	if (meta.form === 1) {
		const cls = className(meta.name);
		return cls !== "" ? `<span class="${cls}">` : "<span>";
	}
	if (meta.form === 2) return "</span>";
	if (meta.typ === "mdxTextExpression" && isComment(token.content)) {
		return `<!--${token.content.slice(3, -3)}-->`;
	}
	return `<code class="mdxNode ${meta.typ}">${escapeHTML(token.content)}</code>`;
}

function renderContainerOpen(tokens: Token[], idx: number): string {
	const cls = className((tokens[idx].meta as { name: string }).name);
	return cls !== "" ? `<div class="${cls}">\n` : "<div>\n";
}

// --- the converter ----------------------------------------------------------

/** The MDX dialect Vale reads. */
export function newMDX(): MarkdownIt {
	const md = new MarkdownIt("commonmark", {
		html: true,
		linkify: true,
		typographer: false,
	});

	md.enable(["table", "strikethrough"]);
	md.use(footnote);
	md.use(taskLists);
	md.use(mathPlugin);

	// MDX removed indented code from the grammar.
	md.block.ruler.disable("code");
	md.block.ruler.before("fence", "mdx_indent", mdxIndent, { alt: [] });

	// Ahead of the HTML block rule, which would otherwise claim a JSX element,
	// and the paragraph rule.
	md.block.ruler.before("html_block", "mdx_esm", mdxEsm, { alt: [] });
	md.block.ruler.before("html_block", "mdx_flow_expr", mdxFlowExpr, {
		alt: ["paragraph", "reference", "blockquote", "list"],
	});
	md.block.ruler.before("html_block", "mdx_jsx_flow", mdxJsxFlow, {
		alt: ["paragraph", "reference", "blockquote", "list"],
	});

	// The HTML block rule declines the line the JSX flow rule declined: a
	// one-line element with text between its tags, which MDX reads as a
	// paragraph holding an inline element. Left to the HTML block rule,
	// `<summary>Click me</summary>` opened a block that ran to the next blank
	// line, and a code fence on the line after it was read as prose.
	md.block.ruler.at("html_block", (state, startLine, endLine, silent) => {
		const pos = state.tShift[startLine];
		const line = rawLine(state, startLine);
		if (opensJsx(line, pos)) {
			const s = new JsxScan();
			const end = tagEnd(line.slice(pos), s);
			if (
				end >= 0 &&
				(s.done || doneOnLine(s, line.slice(pos + end))) &&
				hasText(line.slice(pos + end))
			) {
				return false;
			}
		}
		return htmlBlock(state, startLine, endLine, silent);
	});

	// Behind the autolink rule, so `<https://...>` stays a link, and ahead of
	// the raw-HTML rule, which would otherwise claim an inline JSX tag.
	md.inline.ruler.before("html_inline", "mdx_inline", mdxInline);

	md.renderer.rules.mdx_block = renderBlock;
	md.renderer.rules.mdx_inline = renderInline;
	md.renderer.rules.mdx_container_open = renderContainerOpen;
	md.renderer.rules.mdx_container_close = () => "</div>\n";

	return md;
}

const sharedMDX = newMDX();

/** Reads an MDX file. */
export function lintMDX(host: MDXHost, f: File): void {
	host.lintMetadata(f);

	const src = host.transform(f);
	const env: MDXEnv = {};
	const tokens = sharedMDX.parse(src, env);
	const html = sharedMDX.renderer.render(tokens, sharedMDX.options, env);

	const open = env.mdxUnclosed;
	if (open !== undefined) {
		// The transform rewrites the front matter, so the offset of the block
		// that never closed is not the file's; the file is parsed again for it.
		let placed = open;
		let text = src;
		if (src !== f.content) {
			const fileEnv: MDXEnv = {};
			sharedMDX.parse(f.content, fileEnv);
			if (fileEnv.mdxUnclosed !== undefined) {
				placed = fileEnv.mdxUnclosed;
				text = f.content;
			}
		}
		const line = countNewlines(text.slice(0, placed.offset)) + 1;
		throw newE201FromPosition(
			`Invalid MDX: ${placed.what}, so the rest of the file can't be read.`,
			f.path,
			line,
		);
	}

	f.content = prepMarkdown(maskSpans(f.content, jsxTagSpans(f.content)));
	host.lintHTMLTokens(f, html, 0);
}

function countNewlines(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\n") n++;
	}
	return n;
}
