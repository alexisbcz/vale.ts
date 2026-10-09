/**
 * The state carried through one pass over a document's token stream.
 *
 * The walker's job is to place things. A reader hands it text in document
 * order; it says which line that text is on, where in the source it starts,
 * and which tags, classes and selections are open around it. Everything else
 * in the linter depends on those answers being right, because an alert that
 * cannot be placed is an alert on the wrong line.
 *
 * Two mechanisms do the work. Text already consumed is *masked* out of a
 * private copy of the document, so a search for the next piece cannot land on
 * an earlier copy of itself; and a set of cursors move forward only, so a
 * repeated phrase resolves to its successive occurrences rather than always
 * the first.
 *
 * # The context buffer
 *
 * Masking mutates, and JavaScript strings do not. The buffer is held as code
 * units so a mask costs the length of what it masks, and the string form is
 * rebuilt only when something asks for it -- which is once per block, not once
 * per masked word.
 */

import type { File, Inline, Run } from "@vale-ts/core";
import { Block, strLen } from "@vale-ts/core";
import { type Token, TokenType, unescapeEntities } from "./tokenizer.ts";

/** One inline element's text, gathered as the block containing it is read. */
export interface InlineCapture {
	tag: string;
	scope: string;
	text: string;
	/**
	 * Whether the block will not hold this text.
	 *
	 * A skipped element -- inline code -- is written out of the block, so the
	 * fragment has to be located in the source rather than within the block.
	 */
	masked: boolean;
	/** Where the element's text sits in the block's buffer. */
	begin: number;
	end: number;
}

/** One still-open block container. */
interface OpenTag {
	tag: string;
	cls: string;
	/** The selections the element belongs to. */
	ids: string[];
	/** Gathers the element's text for those selections. */
	agg: Aggregate | null;
}

/**
 * The text of an element a `doc(...)` selector matched, gathered to be linted
 * as one block when the element closes.
 */
export interface Aggregate {
	ids: string[];
	line: number;
	text: string;
	metrics: Record<string, number> | null;
}

/** The size from which the context is indexed rather than scanned. */
const INDEX_MIN = 16 << 10;

/** Where one text occurs in the context, and how many masking has removed. */
interface Occurrences {
	at: number[];
	next: number;
}

export class Walker {
	/** How many lines the file has, plus the reader's offset. */
	readonly lines: number;

	activeTag = "";
	activeCls = "";

	/** The line the walker has reached. */
	idx = 0;

	/** The tags open around the current text, innermost last. */
	tagHistory: string[] = [];
	/** The `class` of each tag opened in the block, inline ones included. */
	clsHistory: string[] = [];
	/** The selections marked on the tags in `tagHistory`. */
	idsHistory: string[] = [];

	/** The inline elements captured within the current block. */
	inline: InlineCapture[] = [];

	/** Every selection the document opened, so absent ones can be reported. */
	seen: Record<string, boolean> = {};

	private readonly ext: string;

	/** The document, with consumed text masked out. */
	private readonly buf: Uint16Array;
	/** The original document, which the occurrence index is built over. */
	private readonly original: string;
	/** `buf` as a string, rebuilt when a mask has invalidated it. */
	private ctxCache: string;
	private ctxDirty = false;

	/** Per text asked about, where it occurs and how far masking has got. */
	private occ: Map<string, Occurrences> | null = null;
	private readonly indexed: boolean;

	/** Where the last line count stopped, and what it reached. */
	private nlOff = 0;
	private nlCount = 0;

	/**
	 * How far into the context blocks have already been emitted.
	 *
	 * Blocks come out in document order, so searching forward from here finds
	 * the right occurrence of a repeated phrase and keeps the total work linear
	 * in the document rather than linear per block.
	 */
	private cursor = 0;

	/** Each segment of text seen in the current block, to mask on reset. */
	private queue: string[] = [];

	/**
	 * Every block container still open.
	 *
	 * Unlike `clsHistory`, this is not reset per block: a container's class
	 * stays in scope for every block inside it, however many that is.
	 */
	private enclosing: OpenTag[] = [];

	/** The selections open around the current block, innermost last. */
	private aggs: Aggregate[] = [];
	/** The one whose element just ended, awaiting the flush. */
	private closedAgg: Aggregate | null = null;

	/** How this block's text maps back to the source. */
	private spans: Run[] = [];
	private srcCursor = 0;

	/**
	 * How far the search for the next comment directive has gone.
	 *
	 * Comments arrive in document order but ahead of the block holding them, so
	 * they need a cursor of their own.
	 */
	private cmtCursor = 0;

	/**
	 * The attribute values of the element just opened, waiting to be masked.
	 *
	 * They cannot be masked on the start tag itself: an autolink's `href` and
	 * its text are the same source characters, so masking the attribute leaves
	 * the text token to find its string somewhere else in the document.
	 */
	private pending: string[] = [];

	private begin = 0;
	private end = 0;

	constructor(f: File, offset: number) {
		this.lines = f.lines.length + offset;
		this.original = f.content;
		this.ctxCache = f.content;
		this.buf = new Uint16Array(f.content.length);
		for (let i = 0; i < f.content.length; i++) {
			this.buf[i] = f.content.charCodeAt(i);
		}
		this.indexed = f.content.length >= INDEX_MIN;
		this.ext = f.normedExt;
	}

	/** The context as a string, with consumed text masked out. */
	getCtx(): string {
		if (this.ctxDirty) {
			this.ctxCache = decodeBuffer(this.buf);
			this.ctxDirty = false;
		}
		return this.ctxCache;
	}

	/**
	 * Where `needle` first occurs in the context as it is now.
	 *
	 * What a plain search would report, without scanning the masked prefix each
	 * time -- which made every search a pass over the consumed document. Masking
	 * only removes occurrences, so the first one still present never moves
	 * back, and each text keeps its place in its own list.
	 */
	private first(needle: string): number {
		if (needle === "") return this.bufIndexOf("", 0);
		if (!this.indexed) return this.bufIndexOf(needle, 0);

		this.occ ??= new Map();
		let o = this.occ.get(needle);
		if (o === undefined) {
			o = { at: allIndexes(this.original, needle), next: 0 };
			this.occ.set(needle, o);
		}

		while (o.next < o.at.length) {
			const p = o.at[o.next]!;
			if (this.bufMatches(needle, p)) return p;
			o.next++;
		}
		return -1;
	}

	/** Whether the buffer holds `needle` at `at`. */
	private bufMatches(needle: string, at: number): boolean {
		if (at + needle.length > this.buf.length) return false;
		for (let i = 0; i < needle.length; i++) {
			if (this.buf[at + i] !== needle.charCodeAt(i)) return false;
		}
		return true;
	}

	/** `indexOf` over the mutable buffer, so no string is rebuilt to search. */
	private bufIndexOf(needle: string, from: number): number {
		if (needle === "") return from <= this.buf.length ? from : -1;
		const limit = this.buf.length - needle.length;
		const head = needle.charCodeAt(0);
		for (let i = Math.max(from, 0); i <= limit; i++) {
			if (this.buf[i] !== head) continue;
			let j = 1;
			while (j < needle.length && this.buf[i + j] === needle.charCodeAt(j)) j++;
			if (j === needle.length) return i;
		}
		return -1;
	}

	/** Counts the newlines before `pos`, from where the last count stopped. */
	private lineAt(pos: number): number {
		if (pos >= this.nlOff) {
			this.nlCount += this.countNewlines(this.nlOff, pos);
		} else {
			this.nlCount -= this.countNewlines(pos, this.nlOff);
		}
		this.nlOff = pos;
		return this.nlCount;
	}

	private countNewlines(from: number, to: number): number {
		let n = 0;
		for (let i = from; i < to; i++) {
			if (this.buf[i] === 10) n++;
		}
		return n;
	}

	/** Masks the first occurrence of `sub`, reporting whether it was found. */
	private sub(sub: string, char: string): boolean {
		const idx = this.first(sub);
		if (idx < 0) return false;
		this.maskAt(idx, sub, char);
		return true;
	}

	/**
	 * Masks `sub` at `idx`, character for character.
	 *
	 * Only characters that occupy one byte in UTF-8 are masked, and newlines are
	 * left alone, so neither positions nor line numbers move. That is the whole
	 * point of masking consumed text rather than removing it.
	 */
	private maskAt(idxArg: number, sub: string, char: string): void {
		const mask = char.charCodeAt(0);
		let idx = idxArg;
		for (const r of sub) {
			const cp = r.codePointAt(0)!;
			if (cp !== 10 && cp < 0x80) {
				this.buf[idx] = mask;
				this.ctxDirty = true;
			}
			idx += r.length;
		}
	}

	/** Masks a token's text out of the context. */
	update(txt: string, tokt: TokenType): void {
		if ((tokt !== TokenType.Text && tokt !== TokenType.Comment) || txt === "") {
			return;
		}
		for (const s of txt.split("\n")) {
			const found = this.sub(s, "@");
			if (!found && this.ext !== ".adoc") {
				for (const f of s.split(/\s+/)) {
					if (f !== "") this.sub(f, "@");
				}
			}
		}
	}

	/**
	 * Masks the attribute values held since the last start tag.
	 *
	 * `text` is the element's own text, if it has arrived; an attribute equal to
	 * it is dropped rather than masked, because the two are one run of source
	 * and masking it twice consumes an occurrence that belongs to something
	 * else.
	 */
	flush(text: string): void {
		for (const val of this.pending) {
			if (val !== text) this.update(val, TokenType.Text);
		}
		this.pending = [];
	}

	/** Ends the current block: masks its text and forgets its tag history. */
	reset(): void {
		this.flush("");
		for (const s of this.queue) this.update(s, TokenType.Text);
		this.queue = [];
		this.tagHistory = [];
		this.clsHistory = [];
		this.idsHistory = [];
		this.inline = [];
		this.spans = [];
	}

	/** Records a piece of the current block's text. */
	append(text: string): void {
		if (text === "") return;
		// Before the search below, so the text finds its own occurrence, and
		// after the drop, so an autolink's `href` does not take it first.
		this.flush(text);

		const pos = this.advance(text);
		if (pos > -1) this.idx = pos;
		this.queue.push(text);
	}

	addTag(tag: string, cls: string, marks: string): void {
		this.tagHistory.push(tag);
		this.clsHistory.push(cls);
		for (const id of marks.split(/\s+/)) {
			if (id !== "") this.idsHistory.push(id);
		}
		this.activeTag = tag;
	}

	/**
	 * Forgets an inline tag once it closes, so the text after it is not read as
	 * inside it.
	 *
	 * Docutils wraps a hyphenated literal in `<tt><span class="pre">`, and with
	 * the pair left in the history every later text node of the paragraph passed
	 * for literal content. The tag's class stays in `clsHistory`: an inline
	 * element's class reaches the scope of the block holding it.
	 */
	popTag(tag: string): void {
		const n = this.tagHistory.length;
		if (n > 0 && this.tagHistory[n - 1] === tag) this.tagHistory.pop();
	}

	/** Records a block container as open. `marks` names the selections on it. */
	enclose(tag: string, cls: string, marks: string): void {
		const open: OpenTag = { tag, cls, ids: [], agg: null };
		const ids = marks.split(/\s+/).filter((s) => s !== "");
		if (ids.length > 0) {
			open.ids = ids;
			open.agg = { ids, line: -1, text: "", metrics: null };
			this.aggs.push(open.agg);
			for (const id of ids) this.seen[id] = true;
		}
		this.enclosing.push(open);
	}

	/**
	 * The ids of every selection the current block is in, without repeats.
	 *
	 * Those of the containers still open around it, and those of the block's own
	 * element, which has closed by the time the block is built.
	 */
	selections(): string[] {
		const found: string[] = [];
		const add = (id: string): void => {
			if (!found.includes(id)) found.push(id);
		};
		for (const o of this.enclosing) {
			for (const id of o.ids) add(id);
		}
		for (const id of this.idsHistory) add(id);
		return found;
	}

	/** Adds a block's text to every selection still open around it. */
	gather(txt: string, line: number, metric: string): void {
		for (const a of this.aggs) {
			if (a.line < 0) a.line = line;
			a.text += `${txt}\n\n`;
		}
		this.count(metric);
	}

	/** Records an element in every open selection. */
	count(metric: string): void {
		for (const a of this.aggs) {
			a.metrics ??= {};
			a.metrics[metric] = (a.metrics[metric] ?? 0) + 1;
		}
	}

	/**
	 * The selection whose element has just closed, or null.
	 *
	 * The aggregate leaves the open set here rather than when the end tag was
	 * read: the flush between the two is what gathers a paragraph's or
	 * heading's own text, and a selection on one gathered nothing when it was
	 * popped first.
	 */
	closeSelection(): Aggregate | null {
		const a = this.closedAgg;
		this.closedAgg = null;
		if (a !== null) {
			const i = this.aggs.lastIndexOf(a);
			if (i >= 0) this.aggs.splice(i, 1);
		}
		return a;
	}

	/**
	 * Closes the innermost open container with the given tag.
	 *
	 * A selection closes with its element, and is held until that element's text
	 * has been flushed, since that text is the element's own.
	 */
	unclose(tag: string): void {
		for (let i = this.enclosing.length - 1; i >= 0; i--) {
			if (this.enclosing[i]!.tag === tag) {
				const agg = this.enclosing[i]!.agg;
				if (agg !== null) this.closedAgg = agg;
				this.enclosing.splice(i, 1);
				return;
			}
		}
	}

	/** The classes enclosing the current block, in order and without repeats. */
	classes(): string[] {
		const found: string[] = [];
		const add = (cls: string): void => {
			for (const name of cls.split(/\s+/)) {
				if (scopeSafe(name) && !found.includes(name)) found.push(name);
			}
		};
		for (const o of this.enclosing) add(o.cls);
		for (const cls of this.clsHistory) add(cls);
		return found;
	}

	setCls(tag: string, cls: boolean): void {
		if (cls) {
			this.activeCls = tag;
			this.begin = 1;
			this.end = 0;
		}
	}

	addCls(tag: string, start: boolean): void {
		if (tag === this.activeCls) {
			if (start) this.begin++;
			else this.end++;
		}
	}

	canClose(): boolean {
		return this.activeCls !== "" && this.begin === this.end && this.begin > 0;
	}

	close(): void {
		this.activeCls = "";
		this.begin = 0;
		this.end = 0;
	}

	/**
	 * Builds the block for `text`, which begins `shift` characters into the runs
	 * recorded as it was read.
	 */
	block(text: string, scope: string, shift: number): Block {
		let line = this.idx;

		const pos = this.advance(text);
		if (pos !== line && pos > -1) line = pos;

		const b = new Block(this.getCtx(), text, scope, line);
		b.offset = this.locate(text);

		// A block whose text is in the source verbatim needs nothing more; one
		// holding inline markup is not there to be found, and only its runs can
		// place a match inside it.
		if (b.offset < 0) b.runs = this.runs(shift, text.length);

		return b;
	}

	/** The recorded runs covering `[shift, shift+n)`, rebased onto a block. */
	private runs(shift: number, n: number): Run[] {
		const out: Run[] = [];
		for (const r of this.spans) {
			const lo = Math.max(r.at, shift);
			const hi = Math.min(r.at + r.n, shift + n);
			if (lo >= hi) continue;
			out.push({ at: lo - shift, src: r.src + (lo - r.at), n: hi - lo });
		}
		return out;
	}

	/**
	 * Where `text` begins in the context, advancing the cursor past it, or -1.
	 *
	 * Recording the position here is what lets checks report offsets. Without it
	 * every alert has to be placed by searching the document and masking what it
	 * matched, which costs a copy of the document per alert.
	 */
	private locate(text: string): number {
		if (text === "" || isMask(text)) return -1;
		if (this.cursor > this.buf.length) return -1;

		// Look a bounded distance ahead rather than to the end of the file.
		//
		// A block that will be found sits just past the cursor -- the gap is the
		// markup between it and the previous block. A block that extraction has
		// rewritten is not in the source at all, and scanning the rest of the
		// document to discover that costs a pass per block.
		const WINDOW = 64 << 10;
		const limit = Math.min(this.cursor + WINDOW, this.buf.length);

		const i = this.bufIndexOfWithin(text, this.cursor, limit);
		if (i < 0) {
			// Extraction can rewrite text -- stripping markup, decoding entities
			// -- leaving something that is not a substring of the source. Those
			// blocks keep the search-based placement.
			return -1;
		}

		this.cursor = i + text.length;
		return i;
	}

	private bufIndexOfWithin(needle: string, from: number, limit: number): number {
		if (needle === "") return from;
		const last = Math.min(limit, this.buf.length) - needle.length;
		const head = needle.charCodeAt(0);
		for (let i = Math.max(from, 0); i <= last; i++) {
			if (this.buf[i] !== head) continue;
			let j = 1;
			while (j < needle.length && this.buf[i + j] === needle.charCodeAt(j)) j++;
			if (j === needle.length) return i;
		}
		return -1;
	}

	/**
	 * Where a comment's text begins in the source, or -1.
	 *
	 * The search runs from the last comment, not from the block cursor: a
	 * converter may emit a block ahead of a comment written before it, as
	 * `rst2html` does with a promoted document title.
	 */
	commentAt(txt: string): number {
		if (txt === "") return -1;
		if (this.cmtCursor > this.buf.length) return -1;

		const i = this.bufIndexOf(txt, this.cmtCursor);
		if (i < 0) return -1;
		this.cmtCursor = i + txt.length;
		return i;
	}

	/**
	 * Records that the run of text at `at` in the current block came from `raw`
	 * in the source, if that can be found from where the last run ended.
	 */
	mapRun(at: number, raw: string): void {
		if (raw === "" || this.srcCursor > this.buf.length) return;
		const i = this.bufIndexOf(raw, this.srcCursor);
		if (i < 0) return;
		this.srcCursor = i + raw.length;
		this.spans.push({ at, src: i, n: raw.length });
	}

	/** Where index `i` of the block's text sits in the source, or -1. */
	sourceOffset(i: number): number {
		for (const s of this.spans) {
			if (i >= s.at && i < s.at + s.n) return s.src + (i - s.at);
		}
		return -1;
	}

	/**
	 * The line `text` sits on, or -1 if that is not ahead of the line already
	 * reached.
	 *
	 * Only the last line of `text` decides the result; the search is for the
	 * first occurrence in the masked context, from the top, which is what keeps
	 * a block's line right when the cursors that place blocks have run ahead.
	 *
	 * The line this returns is a fallback. An alert in a block holding inline
	 * markup is placed by the runs the block was read from; what still comes
	 * through here is a block no run could place.
	 */
	private advance(text: string): number {
		if (isMask(text)) return -1;
		let last = text;
		const i = text.lastIndexOf("\n");
		if (i >= 0) last = text.slice(i + 1);

		let pos = this.first(last);
		if (pos < 0) {
			// Extraction rewrites text, so a line is not always a substring of
			// the source; a single word from it usually still is. The longest
			// word, though: the final one is as often a short `it.` that appears
			// all over the document, landing the block on someone else's line.
			let longest = "";
			for (const f of last.split(/\s+/)) {
				if (f.length > longest.length) longest = f;
			}
			if (longest !== "") pos = this.first(longest);
		}

		if (pos >= 0) {
			const l = this.lineAt(pos);
			if (l > this.idx) return l;
		}
		return -1;
	}

	lastTag(): string {
		if (this.tagHistory.length > 0) {
			return this.tagHistory[this.tagHistory.length - 1]!;
		}
		return this.activeTag;
	}

	/**
	 * Whether the walker is inside a nested list.
	 *
	 * A nested list item is prefixed with a space before being joined to the
	 * item above it, so the two do not fuse into one word.
	 */
	isNestedList(): boolean {
		if (this.lastTag() === "li" && this.tagHistory.length > 3) {
			const up1 = this.tagHistory[this.tagHistory.length - 2]!;
			const up2 = this.tagHistory[this.tagHistory.length - 3]!;
			if (up1 === "ol" || up1 === "ul") return up2 === "li";
		}
		return false;
	}

	/**
	 * Holds an element's interesting attribute values, to be masked after its
	 * text arrives.
	 */
	replaceToks(tok: Token): void {
		const tags = [
			"img",
			"a",
			"p",
			"script",
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
			"span",
		].includes(tok.data);

		// Anything still waiting belongs to an element that had no text.
		this.flush("");
		if (!tags) return;

		const names = ["href", "id", "src", "alt"];
		if (this.ext === ".html") {
			// An inline tag may carry a `class` holding a substring that matches
			// a real finding. Most formats inject those after converting to
			// HTML, so they are not in the original text to be found -- which is
			// why this is only done for HTML itself.
			names.push("class");
		}

		for (const a of tok.attr) {
			if (!names.includes(a.key)) continue;
			let val = a.val;
			if (a.key === "href") {
				try {
					val = decodeURIComponent(val.replaceAll("+", " "));
				} catch {
					// A malformed escape is left as written.
				}
			}
			this.pending.push(val);
		}
	}
}

/**
 * Whether `text` is nothing but mask characters, as a skipped inline element's
 * text is.
 *
 * Such a block is nowhere in the source, and searching for it lands on whatever
 * the source has masked the same way -- an info string -- dragging the cursor
 * past real text.
 */
export function isMask(text: string): boolean {
	if (text === "") return false;
	for (const r of text) {
		if (!"*@ \t\n".includes(r)) return false;
	}
	return true;
}

/**
 * Whether a class can be used as part of a scope.
 *
 * A scope is split on `.`, combined with `&` and negated with `~`, so a class
 * holding one of those would not survive the round trip. Those are dropped
 * rather than rewritten: a silently altered name is harder to explain than an
 * absent one.
 */
export function scopeSafe(cls: string): boolean {
	return cls !== "" && !/[.&~]/.test(cls);
}

/** Every index at which `needle` occurs in `s`, in order. */
function allIndexes(s: string, needle: string): number[] {
	const out: number[] = [];
	if (needle === "") return out;
	for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + 1)) {
		out.push(i);
	}
	return out;
}

/** Builds a string from the context buffer. */
function decodeBuffer(buf: Uint16Array): string {
	// In chunks, because a single spread of a large array overflows the stack.
	const CHUNK = 8192;
	if (buf.length <= CHUNK) return String.fromCharCode(...buf);
	let out = "";
	for (let i = 0; i < buf.length; i += CHUNK) {
		out += String.fromCharCode(...buf.subarray(i, i + CHUNK));
	}
	return out;
}

/** Trims the characters `walk` trims: ASCII whitespace only. */
export function trimASCII(s: string): string {
	let start = 0;
	let end = s.length;
	while (start < end && " \t\n\r\f\v".includes(s[start]!)) start++;
	while (end > start && " \t\n\r\f\v".includes(s[end - 1]!)) end--;
	return s.slice(start, end);
}

/** A token's text as the walker reads it: trimmed, then decoded again. */
export function walkText(tok: Token): string {
	return unescapeEntities(trimASCII(tok.data));
}

export type { Inline };
export { strLen };
