/**
 * Reading a document's HTML as the blocks its rules run against.
 *
 * Every markup format Vale understands is converted to HTML first, so this one
 * pass serves all of them. It walks the token stream, accumulates the text of
 * each block-level element, and when that element closes hands the text to the
 * rules under a scope built from the tags, classes and selections around it.
 *
 * Most of the detail here is about whitespace. The source separated a text node
 * from the markup beside it in some particular way, and that separation is not
 * in the token stream -- so the reader reconstructs it, because `word <b>x</b>`
 * read as `wordx` is a false positive and `word` plus `-x` read as `word -x` is
 * another. Each of those rules was learned from a bug; the comments say which.
 */

import type { Alert, Block, File, Inline, Run } from "@vale-ts/core";
import {
	type Config,
	Block as CoreBlock,
	newE100,
	strLen,
	substitute,
} from "@vale-ts/core";
import {
	getAttribute,
	type Token,
	Tokenizer,
	TokenType,
	unescape,
} from "./tokenizer.ts";
import { type Aggregate, type InlineCapture, trimASCII, Walker } from "./walker.ts";

/** Elements whose contents are not prose. */
export const SKIP_TAGS = ["script", "style", "pre", "noscript", "iframe"];

/**
 * Classes whose contents are not prose.
 *
 * `problematic` is what `rst2html` adds to a processing error, which in Vale's
 * case may be something like a file-insertion URL; `pre` is what it adds to a
 * code span.
 */
export const SKIP_CLASSES = ["problematic", "pre", "code"];

export const INLINE_TAGS = [
	"b",
	"big",
	"i",
	"small",
	"abbr",
	"acronym",
	"cite",
	"dfn",
	"em",
	"kbd",
	"strong",
	"a",
	"br",
	"img",
	"span",
	"sub",
	"sup",
	"code",
	"tt",
	"del",
	"q",
	"samp",
	"var",
];

/** Elements that never carry content, so are never open as containers. */
export const VOID_TAGS = [
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
];

/**
 * The inline elements that can be scoped on their own.
 *
 * These are siblings of `text`, not children of it: a scope of `text` is
 * matched by containment, so `text.link` would be matched by every ordinary
 * rule and the whole style would run a second time over each link. As `link`,
 * only a rule that asks for one does any work.
 */
export const INLINE_TO_SCOPE: Record<string, string> = {
	a: "link",
	strong: "strong",
	b: "strong",
	em: "emphasis",
	i: "emphasis",
	code: "code",
	tt: "code",
	q: "quote",
};

export const TAG_TO_SCOPE: Record<string, string> = {
	th: "text.table.header",
	td: "text.table.cell",
	caption: "text.table.caption",
	li: "text.list",
	blockquote: "text.blockquote",
	figcaption: "text.figure.caption",
};

const HEADING = /^h\d$/;

/** The attribute `markSelections` uses to name the selectors an element matched. */
export const MARK_ATTR = "data-vale-doc";

/**
 * What the reader needs from the linter.
 *
 * Declared as an interface so this file can be read, and tested, without the
 * whole `Linter` around it.
 */
export interface ReaderHost {
	config: Config;
	/** Whether any registered rule names this scope. */
	hasScope(scope: string): boolean;
	/** Every `doc(...)` selector any rule declared. */
	selections(): Array<{ id: string; sel: string }>;
	/** Rewrites the document so selectors and quotations reach the walker. */
	markSelections(
		raw: string,
		sels: Array<{ id: string; sel: string }>,
		quotes: boolean,
	): string;
	lintBlock(f: File, blk: Block, lines: number, pad: number, lookup: boolean): void;
	lintProse(f: File, blk: Block, lines: number, split: boolean): void;
	lintSizedScopes(f: File): void;
}

/** Reads a document's HTML and lints every block in it. */
export function lintHTMLTokens(
	host: ReaderHost,
	f: File,
	rawArg: string,
	offset: number,
): void {
	const cfg = host.config;

	let skipTags = SKIP_TAGS;
	let skipClasses = SKIP_CLASSES;
	if (cfg.skippedScopes.length > 0) skipTags = cfg.skippedScopes;
	if (cfg.ignoredClasses.length > 0) {
		skipClasses = [...SKIP_CLASSES, ...cfg.ignoredClasses];
	}

	let skipped = ["tt", "code", "kbd", "samp"];
	if (cfg.ignoredScopes.length > 0) skipped = cfg.ignoredScopes;

	// Inline elements the style actually asks about; nothing is captured for
	// the rest, so a style that scopes none of them pays nothing at all.
	const wanted: Record<string, string> = {};
	for (const [tag, scope] of Object.entries(INLINE_TO_SCOPE)) {
		if (host.hasScope(scope)) wanted[tag] = scope;
	}

	let raw = rawArg;
	// A rule that names `quote` needs the quotations marked up, which no format
	// but HTML does on its own.
	const quotes = host.hasScope("quote");
	const sels = host.selections();
	if (sels.length > 0 || quotes) {
		try {
			raw = host.markSelections(raw, sels, quotes);
		} catch (err) {
			throw newE100(f.path, err);
		}
	}

	const state = new Walker(f, offset);
	const reader = new TokenReader(raw);

	let buf = "";
	let open: InlineCapture[] = [];

	let inBlock = false;
	let inline = false;
	let skip = false;
	let skipClass = false;
	/**
	 * Whether the previous token closed an inline element. Only then does the
	 * next text node's leading whitespace faithfully reflect the source, since
	 * the walker trims it away before we see it.
	 */
	let closedInline = false;
	/**
	 * The whitespace that ended the block's last text node, as the source had
	 * it: what separated that text from an inline element opening after it.
	 */
	let trailing = "";
	/**
	 * That whitespace when a comment followed the text. The comment is masked
	 * out, so the next text is separated as the source separated the comment.
	 */
	let padComment = "";

	let attr = "";
	let parentClass = "";

	for (;;) {
		const { type: tokt, tok, txt: rawTxt } = reader.next();
		let txt = rawTxt;

		state.addCls(txt, tokt === TokenType.StartTag);
		const closed = state.canClose();

		const cls = getAttribute(tok, "class");
		skipClass = checkClasses(cls, skipClasses);

		if (
			tokt === TokenType.StartTag &&
			!INLINE_TAGS.includes(txt) &&
			!VOID_TAGS.includes(txt)
		) {
			state.enclose(txt, cls, getAttribute(tok, MARK_ATTR));
		} else if (tokt === TokenType.EndTag && !INLINE_TAGS.includes(txt)) {
			state.unclose(txt);
		}

		const blockSkip = skipClass && !INLINE_TAGS.includes(txt);

		if (tokt === TokenType.Error) {
			// Text with no element around it -- a fragment that is a bare
			// paragraph, as a Javadoc description is -- is flushed by the end of
			// the input, since no closing tag will.
			if (buf.trim() !== "") lintScope(host, f, state, buf);
			break;
		}

		if (
			tokt === TokenType.StartTag &&
			!INLINE_TAGS.includes(txt) &&
			(skipTags.includes(txt) || blockSkip)
		) {
			state.setCls(txt, blockSkip);
			inBlock = true;
			f.metrics[txt] = (f.metrics[txt] ?? 0) + 1;
			state.count(txt);
		} else if (
			inBlock &&
			(closed ||
				(tokt === TokenType.EndTag &&
					!INLINE_TAGS.includes(txt) &&
					skipTags.includes(txt)))
		) {
			// Only a block's own end tag closes it: the `<code>` inside a
			// `<pre>` must not, when both are skipped.
			inBlock = false;
			if (closed) state.close();
		} else if (tokt === TokenType.StartTag) {
			// Text buffered before a block-level child belongs to the enclosing
			// element: a tight list item's own text, when a nested list opens
			// inside it. Left in the buffer it fuses with the child's first
			// item, an end-anchored rule sees the child's ending, and the parent
			// item never reaches `list`-scoped rules on its own.
			if (
				!INLINE_TAGS.includes(txt) &&
				!VOID_TAGS.includes(txt) &&
				buf.trim() !== ""
			) {
				lintScope(host, f, state, buf);
				state.reset();
				buf = "";
			}
			if ((txt === "em" || txt === "b") && state.lastTag() === "code") {
				// Emphasis inside a code span is still code.
				txt = "code";
			}
			// A void element mid-sentence, `<source>` or `<wbr>`, separates the
			// words around it as an inline one does; without this the text on
			// either side fused, `The <source> is` as `Theis`.
			inline = INLINE_TAGS.includes(txt) || VOID_TAGS.includes(txt);
			// An inline element named in `SkippedScopes` is masked like an
			// ignored one rather than dropped: `where <code>x</code> is` must not
			// read as `where is`, nor `in <code/> for` as `infor`.
			skip = skipped.includes(txt) || skipTags.includes(txt);
			closedInline = false;
			padComment = "";
			const scope = wanted[txt];
			if (scope !== undefined) {
				// A skipped element's text is masked out of the block, so its
				// capture has to read the text as it arrived instead.
				open.push({
					tag: txt,
					scope,
					masked: skip,
					begin: buf.length,
					text: "",
					end: 0,
				});
			}
			state.addTag(txt, cls, getAttribute(tok, MARK_ATTR));
		} else if (tokt === TokenType.EndTag && INLINE_TAGS.includes(txt)) {
			state.popTag(txt);
			state.activeTag = "";
			closedInline = true;
			padComment = "";
			const n = open.length;
			if (n > 0 && open[n - 1]!.tag === txt) {
				const done = open[n - 1]!;
				open = open.slice(0, n - 1);
				const body = done.text.trim();
				if (body !== "") {
					// The run in the buffer, less the padding `clean` added
					// around the element's text.
					const written = buf.slice(done.begin);
					const begin =
						done.begin + (written.length - trimLeft(written, " \n").length);
					state.inline.push({
						tag: done.tag,
						scope: done.scope,
						masked: done.masked,
						text: body,
						begin,
						end: done.begin + trimRight(written, " \n").length,
					});
				}
			}
		} else if (tokt === TokenType.SelfClosingTag && INLINE_TAGS.includes(txt)) {
			// `<br/>` separates the words around it just as `<br>` does, but
			// arrives as its own token type.
			inline = true;
			closedInline = false;
		} else if (tokt === TokenType.Comment) {
			// A comment, like a closed inline element, is a source-faithful
			// boundary: trust the next text's own whitespace. Inside a still-open
			// inline element the opening tag remains the boundary, so leave the
			// state alone and keep its padding.
			if (!inline) {
				closedInline = true;
				padComment = trailing;
			}
			// Found before `update` masks it out of the context.
			f.updateCommentsAt(txt, state.commentAt(txt));
			state.update(txt, tokt);
		} else if (tokt === TokenType.Text) {
			skip = skip || shouldBeSkipped(state.tagHistory, f.normedExt);
			state.append(txt);
			// Text inside an active `vale off` region is excluded from the block
			// entirely. The whole paragraph is linted at once, on the closing
			// tag, by which point the `off` toggle has flipped back -- so gating
			// `shouldRun` is not enough to suppress an inline `vale off` span.
			if (!inBlock && !f.comments.off && txt !== "") {
				skipClass = checkClasses(parentClass, skipClasses);
				if (state.isNestedList() && !inline) txt = ` ${txt}`;

				// Once an inline element closes, the next token's leading
				// whitespace is exactly what the source had, so trust it rather
				// than inferring one: `<code>X</code>s` must not gain a space and
				// `<strong>x</strong> :` must not lose one. A line break stays a
				// line break, as it does in plain text.
				let sep = leadingSpace(tok.data);
				if (closedInline && sep === "") sep = padComment;
				padComment = "";

				// Kept before `clean`, which empties the text of a skipped
				// element: inline code never reaches the block, so a capture of
				// it has nothing else to read.
				const rawText = txt;
				const cleaned = clean(
					txt,
					attr,
					skip || skipClass,
					inline,
					sep,
					closedInline,
				);
				txt = cleaned.text;
				skip = cleaned.skip;
				closedInline = false;

				// `clean` prefixes inline content with a space so it does not
				// fuse with the preceding text. When that content directly
				// follows a tight boundary -- an opening bracket, a dash -- the
				// space is spurious. Unless the source put whitespace there, in
				// which case removing it would report `—b`.
				if (txt.startsWith(" ") && trailing === "" && endsTight(buf)) {
					txt = txt.slice(1);
				}
				// A non-breaking space before the markup already separates the
				// two, so the padding would double it.
				if (txt.startsWith(" ") && endsWithUnicodeSpace(buf)) {
					txt = txt.slice(1);
				}

				// Record where this run came from before it loses its identity in
				// the block. It places inline fragments, and it places a match in
				// a block that inline markup has made unfindable in the source --
				// `has <b>has</b>` arrives as `has has`, which is nowhere in the
				// file.
				//
				// Only a run that survived extraction unchanged can be mapped;
				// `clean` may have prefixed a separator, which belongs to the
				// block and not to the source.
				const body = trimLeft(txt, " \n");
				if (body === rawText) {
					state.mapRun(buf.length + (txt.length - body.length), rawText);
				}

				buf += txt;

				// Feed the same text to any inline element still open, so a
				// captured fragment matches what the block itself holds -- except
				// where the block holds nothing, and the text as it was read is
				// all there is.
				for (const o of open) {
					o.text += o.masked ? rawText : txt;
				}
			}
			if (!inBlock && !f.comments.off) {
				// A whitespace-only node counts: `<b>x</b> <i>y</i>` puts a space
				// between its elements.
				trailing = trailingSpace(tok.data);
			}
		}

		if (tokt === TokenType.EndTag && !INLINE_TAGS.includes(txt)) {
			if (buf.trim() !== "") lintScope(host, f, state, buf);
			state.reset();
			buf = "";

			// After the flush: the element's own text belongs to it.
			const agg = state.closeSelection();
			if (agg !== null) lintSelection(host, f, agg);
		}

		attr = getAttribute(tok, "href");
		parentClass = getAttribute(tok, "class");

		lintTags(host, f, state, tok);
		state.replaceToks(tok);
	}

	if (sels.length > 0) lintAbsent(host, f, sels, state.seen);

	host.lintSizedScopes(f);
}

/** Pulls tokens, pre-trimming each one's text the way the walker expects. */
class TokenReader {
	private readonly tz: import("./tokenizer.ts").Tokenizer;

	constructor(raw: string) {
		const { Tokenizer } =
			require("./tokenizer.ts") as typeof import("./tokenizer.ts");
		this.tz = new Tokenizer(raw);
	}

	next(): { type: TokenType; tok: Token; txt: string } {
		const type = this.tz.next();
		const tok = this.tz.token();
		// Only ASCII whitespace is trimmed: a non-breaking or narrow space
		// beside inline markup is text the rules should see, not a separator.
		return { type, tok, txt: unescape(trimASCII(tok.data)) };
	}
}

/** Hands one block's text to the rules, under the scope it belongs to. */
export function lintScope(
	host: ReaderHost,
	f: File,
	state: Walker,
	txtArg: string,
): void {
	let txt = txtArg;

	// A `data` element holds a document's machine-readable content -- an anchor
	// name, a file name, an identifier -- which is in the document without being
	// prose.
	//
	// Like `link` and `code`, `meta` is a sibling of `text` rather than a child
	// of it, so an ordinary rule passes over it and only a rule that asks for
	// `meta` does any work. That is the point: the name is reachable for a rule
	// about naming, and invisible to a style about writing. It is not segmented
	// either -- an identifier has no sentences.
	if (state.tagHistory.includes("data")) {
		f.metrics.meta = (f.metrics.meta ?? 0) + 1;
		state.count("meta");

		const b = state.block(
			txt,
			withClasses("meta", state) + metaScope(f) + f.realExt,
			0,
		);
		host.lintBlock(f, b, state.lines, 0, false);
		return;
	}

	for (const tag of state.tagHistory) {
		const mapped = TAG_TO_SCOPE[tag];
		const isHeading = HEADING.test(tag);
		if (!((mapped !== undefined && !INLINE_TAGS.includes(tag)) || isHeading)) {
			continue;
		}

		let scope = mapped ?? "";
		const summarized = scope === "text.blockquote" || scope === "text.list";
		if (mapped === undefined) scope = `text.heading.${tag}`;

		const metric = scope.replace(/^text\./, "");
		f.metrics[metric] = (f.metrics[metric] ?? 0) + 1;

		let shift = txt.length;
		txt = trimLeft(txt, " ");
		shift -= txt.length;

		const b = state.block(
			txt,
			withClasses(scope, state) + f.metaScope + f.realExt,
			shift,
		);
		if (summarized) summarize(f, " ".repeat(shift) + txt, b, shift);
		b.inline = inlineRuns(state.inline, b.text, shift);
		state.gather(txt, b.line, metric);

		// Prose, not just a block: a list item or a heading is made of sentences
		// the same way a paragraph is, and only this path segments them. Sending
		// these straight to `lintBlock` left `sentence.*` blocks existing for
		// paragraphs alone, so any rule scoped to a sentence silently skipped the
		// list items, headings and table cells where much of a document's prose
		// lives.
		//
		// Prose, but not paragraphs: a rule scoped to `paragraph` must not reach
		// a heading or a table cell.
		host.lintProse(f, b, state.lines, false);
		lintInline(host, f, state, b, state.lines, shift);
		return;
	}

	// Counted here rather than from the summary: quotes and list items share the
	// summary so that readability metrics see all of a document's prose, but
	// `paragraphs` means what the `paragraph` scope reaches -- this branch.
	f.metrics.paragraphs = (f.metrics.paragraphs ?? 0) + 1;

	// The space `clean` puts before inline content that opens the paragraph is
	// not in the source; left on, it places the block wherever the text next
	// follows a space.
	let shift = txt.length;
	txt = trimLeft(txt, " ");
	shift -= txt.length;

	const b = state.block(
		txt,
		withClasses("text", state) + f.metaScope + f.realExt,
		shift,
	);
	summarize(f, " ".repeat(shift) + txt, b, shift);
	b.inline = inlineRuns(state.inline, b.text, shift);
	state.gather(txt, b.line, "paragraphs");
	host.lintProse(f, b, state.lines, true);
	lintInline(host, f, state, b, state.lines, shift);
}

/**
 * Adds a block's text to the file's summary, recording where in the source each
 * part of it sits.
 */
export function summarize(f: File, txt: string, blk: Block, shift: number): void {
	const at = f.summary.length + shift;
	f.summary += `${txt}\n\n`;

	if (blk.offset >= 0) {
		f.summaryRuns.push({ at, src: blk.offset, n: blk.text.length });
		return;
	}
	for (const r of blk.runs) {
		f.summaryRuns.push({ at: at + r.at, src: r.src, n: r.n });
	}
}

/**
 * Lints the inline elements captured inside a block -- link text, bold and so
 * on -- as scopes of their own.
 *
 * Their position comes from the block rather than from the walker's cursor,
 * which the block has already consumed: an inline fragment sits inside the text
 * that was just placed, so its offset is the block's plus its index within it.
 */
function lintInline(
	host: ReaderHost,
	f: File,
	state: Walker,
	blk: Block,
	lines: number,
	shift: number,
): void {
	// Captures arrive in document order, so each search starts where the last
	// one ended. Two links with the same text are two alerts; searching from the
	// start each time would place both on the first and lose one.
	//
	// Two cursors, because the two kinds are found in different strings: an
	// ordinary fragment is part of the block and is translated to the source
	// through the runs recorded as it was read, while a masked one -- inline
	// code, written out of the block -- was never in the block to translate.
	let within = 0;
	let source = 0;

	for (const cap of state.inline) {
		let at: number;
		if (cap.masked) {
			[at, source] = seek(blk.context, cap.text, source);
		} else {
			[at, within] = seek(blk.text, cap.text, within);
			if (at >= 0) at = state.sourceOffset(at + shift);
		}

		const b = new CoreBlock(
			blk.context,
			cap.text,
			cap.scope + f.metaScope + f.realExt,
			blk.line,
		);
		b.offset = at;

		// Without an offset the match has to be located by searching, which is
		// what `lookup` asks for.
		host.lintBlock(f, b, lines, 0, at < 0);
	}
}

/**
 * Places each inline element captured in the block within its text, `shift`
 * being what was trimmed from the buffer's front.
 */
export function inlineRuns(
	caps: readonly InlineCapture[],
	text: string,
	shift: number,
): Inline[] {
	const runs: Inline[] = [];
	for (const cap of caps) {
		if (cap.masked || cap.text === "") continue;
		const begin = cap.begin - shift;
		const end = cap.end - shift;
		if (begin < 0 || end > text.length || text.slice(begin, end) !== cap.text) {
			continue;
		}
		runs.push({ scope: cap.scope, begin, end });
	}
	return runs;
}

/**
 * Finds `text` in `s` at or after `from`.
 *
 * A miss leaves the cursor where it was, so one fragment that cannot be placed
 * does not displace the rest.
 */
function seek(s: string, text: string, from: number): [number, number] {
	if (from < 0 || from > s.length) return [-1, from];
	const i = s.indexOf(text, from);
	if (i < 0) return [-1, from];
	return [i, i + text.length];
}

/**
 * Adds the classes and selections enclosing a block to its scope, so markup
 * carrying no distinct tag can still be selected.
 *
 * An AsciiDoc block title is a `<div class="title">`, indistinguishable from
 * body text by tag alone, and becomes `text.class.title` here.
 */
export function withClasses(scope: string, state: Walker): string {
	let out = scope;
	const classes = state.classes();
	if (classes.length > 0) out += `.class.${classes.join(".class.")}`;
	const ids = state.selections();
	if (ids.length > 0) out += `.in.${ids.join(".in.")}`;
	return out;
}

/**
 * The context a fragment carries, with the `text` it opens with taken off.
 *
 * A file's meta scope is appended to every block's scope, and a comment's is
 * `text.comment.line`. A selector matches on the set of sections a scope has,
 * so appending that to `meta` would put `text` back and let an ordinary rule
 * match the content `meta` exists to hold apart.
 */
export function metaScope(f: File): string {
	return f.metaScope.startsWith(".text")
		? f.metaScope.slice(".text".length)
		: f.metaScope;
}

/** Lints the `alt` text of an image and a page's `description`. */
function lintTags(host: ReaderHost, f: File, state: Walker, tok: Token): void {
	const cfg = host.config;

	if (tok.data === "img" && !cfg.skippedScopes.includes("alt")) {
		for (const a of tok.attr) {
			if (a.key !== "alt") continue;
			host.lintBlock(
				f,
				state.block(a.val, `text.attr.${a.key}`, 0),
				state.lines,
				0,
				false,
			);
		}
	}

	// A page's description is prose the page shows nowhere: what a search result
	// or a link preview says about it.
	if (
		tok.data === "meta" &&
		!cfg.skippedScopes.includes("description") &&
		isDescription(tok)
	) {
		const content = getAttribute(tok, "content");
		if (content !== "") {
			host.lintBlock(
				f,
				state.block(content, "text.attr.description", 0),
				state.lines,
				0,
				false,
			);
		}
	}
}

/** Whether a `meta` element carries the page's description. */
function isDescription(tok: Token): boolean {
	return (
		getAttribute(tok, "name") === "description" ||
		getAttribute(tok, "property") === "og:description"
	);
}

/**
 * Lints an empty block for each selection the document never opened, so a rule
 * can report that the element it names is missing.
 *
 * The block sits on line one, which is the only place a missing section can be
 * reported. Every check but a count sees nothing and says nothing.
 */
function lintAbsent(
	host: ReaderHost,
	f: File,
	sels: ReadonlyArray<{ id: string; sel: string }>,
	seen: Record<string, boolean>,
): void {
	for (const s of sels) {
		if (seen[s.id]) continue;
		const blk = new CoreBlock(
			f.content,
			"",
			`doc.${s.id}${f.metaScope}${f.realExt}`,
			0,
		);
		host.lintBlock(f, blk, f.lines.length, 0, true);
	}
}

/**
 * Lints a matched element as one block, for a rule whose scope is a `doc(...)`
 * term alone.
 *
 * The block's scope is `doc` plus the id of every selector that matched the
 * element, so an element two selectors both name is linted once.
 */
function lintSelection(host: ReaderHost, f: File, agg: Aggregate): void {
	const text = agg.text.trim();
	if (text === "") return;

	const scope = `doc.${agg.ids.join(".")}${f.metaScope}${f.realExt}`;
	const blk = new CoreBlock(f.content, text, scope, agg.line);
	blk.metrics = agg.metrics;

	host.lintBlock(f, blk, f.lines.length, 0, true);
}

function checkClasses(attr: string, ignore: readonly string[]): boolean {
	for (const cls of attr.split(" ")) {
		if (ignore.includes(cls)) return true;
	}
	return false;
}

/**
 * Whether text inside the current tags is a literal rather than prose.
 *
 * Docutils wraps the words of a literal in `pre` spans inside a `tt`, so the
 * nearest enclosing tag that is not a span is the one to judge by.
 */
export function shouldBeSkipped(
	tagHistory: readonly string[],
	ext: string,
): boolean {
	if (ext !== ".rst") return false;
	for (let i = tagHistory.length - 1; i >= 0; i--) {
		if (tagHistory[i] === "span") continue;
		return tagHistory[i] === "tt";
	}
	return false;
}

/**
 * Whether the buffer ends with a character that binds tightly to what follows
 * -- an opening bracket or a dash -- so inline content after it should not be
 * padded with a leading space.
 */
function endsTight(buf: string): boolean {
	const r = lastChar(buf);
	return r === "(" || r === "[" || r === "{" || r === "—" || r === "–";
}

/** Whether the buffer ends with a non-ASCII space, which `walk` keeps as text. */
function endsWithUnicodeSpace(buf: string): boolean {
	const r = lastChar(buf);
	return r !== "" && r.codePointAt(0)! >= 0x80 && /\s/u.test(r);
}

function lastChar(s: string): string {
	if (s === "") return "";
	const code = s.charCodeAt(s.length - 1);
	if (code >= 0xdc00 && code <= 0xdfff && s.length >= 2) return s.slice(-2);
	return s[s.length - 1]!;
}

/**
 * The separator the source put before `s`: a newline for a line break, a space
 * for any other whitespace, and "" when there was none.
 *
 * Applied to the raw token data -- before the walker trims it -- to recover how
 * the source actually separated a text node from the markup preceding it.
 */
export function leadingSpace(s: string): string {
	if (s === "") return "";
	switch (s[0]) {
		case "\n":
		case "\r":
			return "\n";
		case " ":
		case "\t":
			return " ";
		default:
			return "";
	}
}

/** The separator the source put after `s`. */
export function trailingSpace(s: string): string {
	if (s === "") return "";
	switch (s[s.length - 1]) {
		case "\n":
		case "\r":
			return "\n";
		case " ":
		case "\t":
			return " ";
		default:
			return "";
	}
}

/**
 * Prepares one text node for the block it is joining.
 *
 * A skipped element's text is replaced by a mask of the same width, so that
 * positions after it do not move but nothing in it is read as prose. Text that
 * follows a closed inline element is separated exactly as the source separated
 * it; elsewhere -- text *inside* an inline element -- the opening tag is the
 * boundary and carries no whitespace of its own, so inline content is padded,
 * or `in <code/> for` collapses to `infor`.
 */
export function clean(
	txtArg: string,
	attr: string,
	skipArg: boolean,
	inline: boolean,
	sep: string,
	closedInline: boolean,
): { text: string; skip: boolean } {
	let txt = txtArg;
	let skip = skipArg;

	// Closing brackets are included so that inline content immediately followed
	// by one -- a link inside parentheses -- does not get a spurious space
	// before it. Dashes are included so `—This` right after a link is not padded.
	const punct = [".", "?", "!", ",", ":", ";", ")", "]", "}", "—", "–"];
	const first = txt === "" ? "" : String.fromCodePoint(txt.codePointAt(0)!);
	const starter = punct.includes(first) && !skip;

	if (skip || attr === txt) {
		[txt] = substitute(txt, txt, "*");
		skip = false;
	}

	if (closedInline && sep !== "") {
		txt = sep + txt;
	} else if (!closedInline && inline && !starter) {
		txt = ` ${txt}`;
	}

	return { text: txt, skip };
}

function trimLeft(s: string, chars: string): string {
	let i = 0;
	while (i < s.length && chars.includes(s[i]!)) i++;
	return s.slice(i);
}

function trimRight(s: string, chars: string): string {
	let i = s.length;
	while (i > 0 && chars.includes(s[i - 1]!)) i--;
	return s.slice(0, i);
}

export type { Alert, Run };
export { strLen };
