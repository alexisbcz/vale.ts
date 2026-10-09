/**
 * The unit a rule runs against.
 *
 * A reader turns a document into blocks: a paragraph, a heading, a table cell,
 * a sentence within one of those. Each block carries the text to check, the
 * larger text it was taken from, and -- where the reader could say -- where in
 * that larger text it begins. That last part is what keeps an alert on the
 * right line: without it a match has to be found by searching the document for
 * its text, which lands on the first copy rather than the one that matched.
 */

import { newDocument, type Document as SummaryDocument } from "@vale-ts/nlp";
import { splitAfterLines } from "./util.ts";

/** How far `resolveOffset` will scan to place a block that was not placed. */
const MAX_OFFSET_SCAN = 8 << 10;

/**
 * A piece of a block's text and where it came from.
 *
 * Extraction drops inline markup, so `has <b>has</b>` arrives as `has has` and
 * the block is nowhere in its context as a whole. Its pieces are, though, and
 * each was placed as it was read.
 */
export interface Run {
	/** Where the piece starts in the block's text. */
	at: number;
	/** Where it starts in the source. */
	src: number;
	/** How long both are. */
	n: number;
}

/** A run of a block's text that an inline element holds. */
export interface Inline {
	scope: string;
	begin: number;
	end: number;
}

export class Block {
	/** The larger text this block was taken from. */
	context: string;
	/** The 1-based source line, or -1 when the reader could not say. */
	line: number;
	/** The selector this block answers to. */
	scope: string;
	/** The fully-qualified selector of the block it came from. */
	parent: string;
	/** The text to check. */
	text: string;

	/**
	 * `text` lower-cased, for the literal prefilter that decides whether a
	 * rule's pattern can match at all.
	 *
	 * Computed once per block, because every rule would otherwise repeat it.
	 */
	lower: string;

	/** Where `text` begins within `context`, or -1 when that is not known. */
	offset: number;

	/**
	 * The elements this block holds, by level -- headings, list items and so
	 * on -- for a `metric` rule measuring it.
	 */
	metrics: Record<string, number> | null = null;

	/** Pieces of `text` mapped back to the source they were read from. */
	runs: Run[] = [];

	/** Where the inline elements `text` holds begin and end. */
	inline: Inline[] = [];

	private summary: SummaryDocument | null = null;

	constructor(ctx: string, txt: string, sel: string, line = -1) {
		let context = ctx;
		let offset = -1;
		if (context === "") {
			context = txt;
			offset = 0;
		}
		this.context = context;
		this.text = txt;
		this.lower = txt.toLowerCase();
		this.scope = sel;
		this.parent = sel;
		this.line = line;
		this.offset = offset;
	}

	/** A block whose context is its own text. */
	static of(txt: string, sel: string): Block {
		return new Block("", txt, sel);
	}

	/** A shallow copy, so a caller can adjust one field without side effects. */
	clone(): Block {
		const b = new Block(this.context, this.text, this.scope, this.line);
		b.parent = this.parent;
		b.offset = this.offset;
		b.metrics = this.metrics;
		b.runs = this.runs;
		b.inline = this.inline;
		b.summary = this.summary;
		b.lower = this.lower;
		return b;
	}

	/** A copy positioned at `offset` within its context. */
	at(offset: number): Block {
		const b = this.clone();
		b.offset = offset;
		return b;
	}

	/** A copy with `scope` replaced. */
	withScope(scope: string): Block {
		const b = this.clone();
		b.scope = scope;
		return b;
	}

	/**
	 * The block's document statistics, computed once and shared by every rule
	 * that reads them.
	 */
	summarize(): SummaryDocument {
		if (this.summary === null) this.summary = newDocument(this.text);
		return this.summary;
	}

	/**
	 * Converts a span within `text` to offsets into it.
	 *
	 * Go needs this because its regular-expression engine reports rune
	 * positions while its strings are indexed in bytes. Here both are string
	 * indices, so the span passes through -- the method stays because the
	 * ported checks call it, and because it still has the bounds check to do.
	 */
	byteSpan(from: number, to: number): [number, number, boolean] {
		if (from < 0 || to < from || to > this.text.length) return [0, 0, false];
		return [from, to, true];
	}

	/** Where index `i` of `text` sits in `context`, or -1 if it was never mapped. */
	sourceOffset(i: number): number {
		if (this.offset >= 0) return this.offset + i;
		for (const r of this.runs) {
			if (i >= r.at && i < r.at + r.n) return r.src + (i - r.at);
		}
		return -1;
	}

	/**
	 * A copy with the text of the inline elements carrying any of `scopes`
	 * blanked, character for character, so positions still hold.
	 */
	without(scopes: readonly string[]): Block {
		if (this.inline.length === 0) return this;
		const chars = [...this.text];
		// Working on an array of characters rather than the string so that a
		// blanked astral character stays one character wide.
		const bounds = charBounds(this.text);
		let changed = false;
		for (const inline of this.inline) {
			if (!scopes.includes(inline.scope)) continue;
			if (inline.end > this.text.length) continue;
			changed = true;
			for (let i = 0; i < bounds.length; i++) {
				const start = bounds[i]!;
				if (start >= inline.begin && start < inline.end) chars[i] = " ";
			}
		}
		if (!changed) return this;

		const b = this.clone();
		b.text = chars.join("");
		b.lower = b.text.toLowerCase();
		b.summary = null;
		return b;
	}

	/**
	 * A copy carrying the parent's runs that fall within this block's text,
	 * rebased onto it.
	 */
	withRuns(parent: readonly Run[], start: number): Block {
		if (start < 0 || parent.length === 0) return this;
		const b = this.clone();
		const end = start + this.text.length;
		const runs: Run[] = [];
		for (const r of parent) {
			const lo = Math.max(r.at, start);
			const hi = Math.min(r.at + r.n, end);
			if (lo >= hi) continue;
			runs.push({ at: lo - start, src: r.src + (lo - r.at), n: hi - lo });
		}
		b.runs = runs;
		return b;
	}

	/** A copy carrying the parent's inline runs that fall within this block. */
	withInline(parent: readonly Inline[], start: number): Block {
		if (parent.length === 0) return this;
		const b = this.clone();
		const inline: Inline[] = [];
		for (const i of parent) {
			if (i.begin >= start && i.end <= start + this.text.length) {
				inline.push({ scope: i.scope, begin: i.begin - start, end: i.end - start });
			}
		}
		b.inline = inline;
		return b;
	}

	/**
	 * Where `text` sits within `context`, recovered when it was not recorded.
	 *
	 * Only when the text occurs exactly once: with several occurrences there is
	 * no telling which one this block is, and guessing would reintroduce the
	 * mislocation the offset exists to prevent.
	 */
	resolveOffset(): number {
		if (this.offset >= 0) return this.offset;
		if (this.text === this.context) return 0;

		// Recovering it means scanning the context, once per block, which is
		// quadratic on a large document. Past a threshold, give up and let the
		// caller fall back to locating alerts by search.
		if (this.context.length > MAX_OFFSET_SCAN) return -1;

		const first = this.context.indexOf(this.text);
		if (first < 0) return -1;
		if (this.context.includes(this.text, first + this.text.length)) return -1;
		return first;
	}
}

/** The string index at which each character of `s` begins. */
function charBounds(s: string): number[] {
	const out: number[] = [];
	for (let i = 0; i < s.length; ) {
		out.push(i);
		const cp = s.codePointAt(i)!;
		i += cp > 0xffff ? 2 : 1;
	}
	return out;
}

/** `s` with every character replaced by a space, so positions do not move. */
export function blankRunes(s: string): string {
	let out = "";
	for (const _ of s) out += " ";
	return out;
}

/**
 * What a file needs from the language layer.
 *
 * Held per file so that a project can mix languages: one file might be `en`
 * and another `ja`.
 */
export interface NLPInfo {
	/** The file's language. */
	lang: string;
	/** An external API to call instead of the built-in models. */
	endpoint: string;
	/** The file's extension scope. */
	scope: string;
	/** Whether anything asked for part-of-speech tags. */
	tagging: boolean;
	/** Whether anything asked for sentences. */
	segmentation: boolean;
	/** Whether anything asked for paragraphs. */
	splitting: boolean;
}

export function newNLPInfo(partial: Partial<NLPInfo> = {}): NLPInfo {
	return {
		lang: "en",
		endpoint: "",
		scope: "",
		tagging: false,
		segmentation: false,
		splitting: false,
		...partial,
	};
}

/** Splits text into sentences. */
export type Segmenter = (text: string) => string[];

/**
 * Breaks a block into the blocks the rules will run against: its paragraphs,
 * its sentences, and the block itself.
 *
 * `split` says whether the block holds paragraphs. Headings, list items and
 * table cells are segmented into sentences like any other prose, but they are
 * not paragraphs, and a rule scoped to `paragraph` must not reach them.
 */
export function computeBlocks(
	info: NLPInfo,
	block: Block,
	split: boolean,
	segment: Segmenter,
): Block[] {
	const blocks: Block[] = [];
	const ctx = block.context;
	const idx = block.line;
	const base = block.resolveOffset();

	if (info.splitting && split) {
		const cursor = { at: 0 };
		for (const p of splitAfterParagraphs(block.text)) {
			const b = new Block(ctx, p, `paragraph.${block.scope}`, idx);
			const [start, off] = offsetOf(block, base, p, cursor);
			blocks.push(
				b.at(off).withRuns(block.runs, start).withInline(block.inline, start),
			);
		}
	}

	if (info.segmentation) {
		const cursor = { at: 0 };
		for (const raw of segment(block.text)) {
			const s = raw.trim();
			if (s === "") continue;
			const b = new Block(ctx, s, `sentence.${block.scope}`, idx);
			const [start, off] = offsetOf(block, base, s, cursor);
			blocks.push(
				b.at(off).withRuns(block.runs, start).withInline(block.inline, start),
			);
		}
	}

	// The block itself, which is what most rules run against. It needs the
	// offset as much as its children do.
	const self = new Block(ctx, block.text, block.scope, idx);
	self.metrics = block.metrics;
	blocks.push(self.at(base).withRuns(block.runs, 0).withInline(block.inline, 0));

	return blocks;
}

/** Go's `strings.SplitAfter(text, "\n\n")`. */
function splitAfterParagraphs(text: string): string[] {
	const out: string[] = [];
	let start = 0;
	for (;;) {
		const i = text.indexOf("\n\n", start);
		if (i < 0) {
			out.push(text.slice(start));
			return out;
		}
		out.push(text.slice(start, i + 2));
		start = i + 2;
	}
}

/**
 * Locates `piece` within the block's text and returns its offset in the
 * block's context, or -1 if it cannot be placed.
 *
 * The cursor advances past each piece so that repeated text resolves to
 * successive occurrences rather than always the first -- which is the whole
 * point of tracking offsets instead of searching for them later.
 */
function offsetOf(
	blk: Block,
	base: number,
	piece: string,
	cursor: { at: number },
): [number, number] {
	if (cursor.at > blk.text.length) return [-1, -1];

	const i = blk.text.indexOf(piece, cursor.at);
	if (i < 0) {
		// A segmenter that rewrites text can return something that is not a
		// substring of its input.
		return [-1, -1];
	}

	const start = i;
	cursor.at = start + piece.length;

	if (base < 0) {
		// The piece is placed within the block, which is itself unplaced; the
		// runs it inherits are what will locate it.
		return [start, -1];
	}
	return [start, base + start];
}

export { splitAfterLines };
