/**
 * A file being linted: its text, the rules that apply to it, and the alerts
 * found in it.
 *
 * Most of the work here is placing an alert. A check reports a span within the
 * block it was given; the user needs a line and a column in the file. The
 * block's own position settles it when the reader recorded one, and otherwise
 * the match is searched for -- with the text already reported masked out, so
 * that three alerts on the same word land on its three occurrences rather than
 * three times on the first.
 */

import { readFileSync } from "node:fs";
import {
	newDocument,
	type Document as SummaryDocument,
	segmentText,
	tokenizeWords,
} from "@vale-ts/nlp";
import type { Alert } from "./alert.ts";
import { sortAlerts } from "./alert.ts";
import type { Block, NLPInfo, Run } from "./block.ts";
import { newNLPInfo } from "./block.ts";
import type { Config } from "./config.ts";
import { warnDroppedStyles } from "./config.ts";
import { newE201FromPosition } from "./errors.ts";
import { formatFromExt, normalizePathFormat } from "./format.ts";
import {
	countPrior,
	initialPosition,
	lineStarts,
	locateMatch,
	locFromOffset,
	maskedOffset,
	maskMatch,
	spanAt,
	upperBound,
} from "./location.ts";
import { blockMetrics } from "./metrics.ts";
import { fileExists, path as nodePath } from "./system.ts";
import {
	extName,
	findShifts,
	RSQUO_SHIFT,
	sanitize,
	splitAfterLines,
	strLen,
	styleName,
	substitute,
} from "./util.ts";

/** `vale <rule> = YES` and friends. */
const COMMENT_CONTROL = /^vale (.+\..+|[^.]+) = (YES|NO|on|off)$/;
/** `vale style = ...` */
const COMMENT_STYLE = /^vale styles? = (.*)$/;
/** `vale <rule>["match"] = NO` */
const COMMENT_CONTROL_MATCHES = /^vale (.+\..+)(\[.+\]) = (YES|NO)$/;

/**
 * The span of the source between a comment directive that turned a check off
 * and the one that turned it back on.
 *
 * Positions are the 1-based line and column pairs alerts carry, so a located
 * alert compares directly. An open region runs to the end of the file.
 */
interface CommentRegion {
	begin: [number, number];
	end: [number, number];
	open: boolean;
}

export class File {
	/** What this file needs from the language layer. */
	nlp: NLPInfo;

	/** The text the summarization checks measure. */
	summary = "";

	/**
	 * Where each piece of the summary came from.
	 *
	 * A match found in the summary is reported at the text that was counted.
	 * Without these the match is located by searching the content for its
	 * text, and a copy in front matter, a code block or a heading -- none of
	 * which the summary holds -- takes the alert.
	 */
	summaryRuns: Run[] = [];

	/** Every alert found in this file. */
	alerts: Alert[] = [];
	/** The styles the configuration turns on for this file. */
	baseStyles: string[] = [];
	/** The content split into lines, each keeping its newline. */
	lines: string[] = [];
	/** Running state a rule keeps across blocks, such as defined abbreviations. */
	sequences: string[] = [];
	/** The file's text, sanitized. */
	content = "";
	/** `markup`, `code`, `data`, `fragment` or `text`. */
	format = "";
	/** The extension Vale reads the file as. */
	normedExt = "";
	/** The path as given. */
	path = "";
	/** The path with the extension `[formats]` maps it to. */
	normedPath = "";
	/** An XSLT stylesheet to run the file through first. */
	transform = "";
	/** The conditional sections whose `if` held for this file. */
	held: Record<string, boolean> = {};
	/** The extension on disk. */
	realExt = "";
	/** Whether each rule runs, from the sections that matched. */
	checks: Record<string, boolean> = {};
	/** Keys a section marked `UNSET`, for which no global setting applies. */
	unset: Record<string, boolean> = {};
	/** The vocabularies this file's sections name. */
	vocab: string[] = [];
	/** The masked context each check is searching, by check. */
	chkToCtx: Record<string, string> = {};

	/**
	 * The level each rule was given by the sections matching this file.
	 *
	 * Not the same as the level it was compiled with: one rule can be an error
	 * in one format and a warning in another.
	 */
	levels: Record<string, string> = {};

	/** Comment control statements, by key, saying whether a check is off. */
	comments: Record<string, boolean> = {};
	/** Count-based measurements the reader collected. */
	metrics: Record<string, number> = {};
	/** Whether the file is being linted from stdin. */
	lookup = false;
	/** Extra scope context, such as a YAML key or a comment's kind. */
	metaScope = "";

	/**
	 * The text of every value a view found, by scope name, so a rule can ask
	 * about a scope other than the one it runs in.
	 */
	scoped: Record<string, string[]> = {};

	/**
	 * How many occurrences of each match have already been masked into
	 * `chkToCtx` this block.
	 *
	 * An occurrence a prior alert consumed is gone from the context, so it must
	 * not widen a later alert's occurrence skip.
	 */
	private chkMasked: Record<string, number> = {};

	/** Where the sanitizer's `&rsquo;` rewrite shortened each line. */
	private sanShifts: Map<number, number[]> | null = null;

	/** Spans covered by comment directives, by key. */
	private regions: Record<string, CommentRegion[]> = {};

	/** Alerts already reported, by position, so none is reported twice. */
	private history: Record<string, number> = {};

	/** How many times each check has reported, for its `limit`. */
	private limits: Record<string, number> = {};

	private simple = false;

	/** The line index, and the context it was built from. */
	private lineIdx: number[] | null = null;
	private lineIdxCtx = "";

	/** The running column count `offsetLoc` keeps. */
	private colCtx = "";
	private colLine = 0;
	private colAt = 0;
	private colChars = 0;

	constructor(nlp?: NLPInfo) {
		this.nlp = nlp ?? newNLPInfo();
	}

	/**
	 * The offset at which each line of `ctx` begins.
	 *
	 * Locating an alert needs the number of newlines before it. Counting them
	 * per alert is a scan of the document each time, and alert count grows with
	 * document size, so the index is built once and searched instead.
	 */
	lineStarts(ctx: string): number[] {
		// Comparing the context is cheap when it is the same string, which is
		// the common case.
		if (this.lineIdx !== null && this.lineIdxCtx === ctx) return this.lineIdx;
		const starts = lineStarts(ctx);
		this.lineIdx = starts;
		this.lineIdxCtx = ctx;
		return starts;
	}

	/** Resets the per-block alert state. */
	startBlock(): void {
		this.chkToCtx = {};
		this.chkMasked = {};
	}

	/** Replaces the file's text, and forgets what was reported where. */
	setText(s: string): void {
		this.content = s;
		this.lines = splitAfterLines(s);
		this.history = {};
		this.lineIdx = null;
		this.lineIdxCtx = "";
	}

	/**
	 * Puts the file's text back after values were linted in its place, keeping
	 * the alerts already reported from being reported again.
	 */
	restoreText(s: string): void {
		this.setText(s);
		for (const a of this.alerts) this.history[historyKey(a)] = 1;
	}

	/** Sets the normalized extension. */
	setNormedExt(ext: string): void {
		this.normedExt = `.${ext}`;
	}

	/**
	 * Sets an optional scope appended to each check's scope, giving it extra
	 * context.
	 *
	 * It lives on the file because files are linted concurrently.
	 */
	setMetaScope(scope: string): void {
		this.metaScope = scope !== "" ? `.${scope}` : "";
	}

	/**
	 * The level `name` should report at in this file, falling back to the level
	 * it was compiled with.
	 *
	 * A rule's own level covers it; a level set for its style covers the rest
	 * of that style, mirroring how the two resolve at compile time.
	 */
	level(name: string, compiled: string): string {
		const own = this.levels[name];
		if (own !== undefined) return own;
		const forStyle = this.levels[styleName(name)];
		if (forStyle !== undefined) return forStyle;
		return compiled;
	}

	/** Every alert, sorted by line and column. */
	sortedAlerts(): Alert[] {
		return sortAlerts(this.alerts);
	}

	/** The whole file's measurements. */
	computeMetrics(): Record<string, number> {
		return blockMetrics(newDocument(this.summary), this.metrics);
	}

	/** The summary as a document, for a rule measuring the whole file. */
	summaryDocument(): SummaryDocument {
		return newDocument(this.summary);
	}

	/**
	 * Shifts and widens alert spans to account for the sanitizer's `&rsquo;`
	 * rewrite, so every span indexes the file's actual text rather than the
	 * sanitized copy that was linted.
	 */
	mapAlertsToSource(): void {
		if (this.sanShifts === null || this.sanShifts.size === 0) return;

		for (const a of this.alerts) {
			if (a.span.length < 2 || a.span[0]! <= 0) continue;

			let d0 = 0;
			let d1 = 0;
			for (const col of this.sanShifts.get(a.line) ?? []) {
				if (col < a.span[0]!) {
					// A rewrite before the match moves the whole span right.
					d0 += RSQUO_SHIFT;
					d1 += RSQUO_SHIFT;
				} else if (col <= a.span[1]!) {
					// A rewrite inside the match widens it.
					d1 += RSQUO_SHIFT;
				}
			}

			a.span[0]! += d0;
			a.span[1]! += d1;
		}
	}

	// --- comment directives -------------------------------------------------

	/** Reads a comment directive. */
	updateComments(comment: string): void {
		this.updateCommentsAt(comment, -1);
	}

	/**
	 * Reads a comment directive that begins at offset `off` of the file's
	 * content, or -1 when its position is not known.
	 *
	 * The position is what lets a directive work inside a block. The toggles
	 * are read once per block, so a `NO`/`YES` pair inside one paragraph has
	 * cancelled out by the time the paragraph is linted; the recorded region
	 * suppresses the located alerts instead.
	 */
	updateCommentsAt(comment: string, off: number): void {
		if (comment === "vale off") {
			this.setComment("off", true, off);
			return;
		}
		if (comment === "vale on") {
			this.setComment("off", false, off);
			return;
		}

		const matches = COMMENT_CONTROL_MATCHES.exec(comment);
		if (matches !== null) {
			try {
				const parts = JSON.parse(matches[2]!) as string[];
				for (const part of parts) {
					this.setComment(`${matches[1]}[${part}]`, matches[3] === "NO", off);
				}
			} catch {
				// A directive whose bracketed list is not JSON names nothing.
			}
			return;
		}

		const control = COMMENT_CONTROL.exec(comment);
		if (control !== null) {
			this.setComment(
				control[1]!,
				control[2] === "NO" || control[2] === "off",
				off,
			);
			return;
		}

		const style = COMMENT_STYLE.exec(comment);
		if (style !== null) {
			for (const s of this.baseStyles) this.comments[s] = true;
			for (const s of style[1]!.split(", ")) this.comments[s] = false;
		}
	}

	/**
	 * Flips one directive key and, when its position is known, opens or closes
	 * the region it covers.
	 */
	private setComment(key: string, disabled: boolean, offArg: number): void {
		this.comments[key] = disabled;
		if (offArg < 0) return;

		const off = Math.min(offArg, this.content.length);
		const [line, span] = locFromOffset(
			this.content,
			this.lineStarts(this.content),
			off,
			off,
			0,
		);
		const at: [number, number] = [line, span[0]!];

		this.regions[key] ??= [];
		const regions = this.regions[key];
		if (disabled) {
			if (regions.length > 0 && regions[regions.length - 1]!.open) return;
			regions.push({ begin: at, end: [0, 0], open: true });
		} else if (regions.length > 0 && regions[regions.length - 1]!.open) {
			const last = regions[regions.length - 1]!;
			last.end = at;
			last.open = false;
		}
	}

	/**
	 * Whether a comment directive covers `check` at the given 1-based location.
	 */
	regionDisabled(check: string, match: string, line: number, col: number): boolean {
		if (Object.keys(this.regions).length === 0) return false;

		const keys = ["off", check];
		const style = styleName(check);
		if (style !== check) keys.push(style);
		if (match !== "") keys.push(`${check}[${match}]`);

		for (const key of keys) {
			for (const r of this.regions[key] ?? []) {
				const after =
					r.begin[0] < line || (r.begin[0] === line && r.begin[1] <= col);
				const before =
					r.open || line < r.end[0] || (line === r.end[0] && col < r.end[1]);
				if (after && before) return true;
			}
		}
		return false;
	}

	/** Removes the alerts that fall inside a comment region. */
	dropDisabled(): void {
		if (Object.keys(this.regions).length === 0) return;
		this.alerts = this.alerts.filter(
			(a) => !this.regionDisabled(a.check, a.match, a.line, a.span[0]!),
		);
	}

	/** Whether an in-text comment has switched `check` off. */
	queryComments(check: string): boolean {
		if (this.comments.off) return true;
		const dot = check.indexOf(".");
		if (dot > 0 && this.comments[check.slice(0, dot)]) return true;
		return this.comments[check] === true;
	}

	/** Switches every check back on. */
	resetComments(): void {
		for (const check of Object.keys(this.comments)) {
			if (check !== "off") this.comments[check] = false;
		}
	}

	// --- placing an alert ---------------------------------------------------

	/**
	 * Works out where an alert is and adds it to the file.
	 *
	 * `lines` is how many lines of the context have been consumed, `pad` is a
	 * column offset the reader asks for, and `lookup` says to skip the
	 * line-based placement and search instead.
	 */
	addAlert(
		alert: Alert,
		blk: Block,
		lines: number,
		pad: number,
		lookup: boolean,
	): void {
		const a = alert;
		let ctx = blk.context;
		const masked = this.chkToCtx[a.check];
		if (masked !== undefined) ctx = masked;

		// Where the match was found in `ctx`, for the mask below.
		let hit = -1;

		if (
			a.hasByteOffsets === true &&
			a.span[0]! >= 0 &&
			a.span[1]! <= blk.context.length
		) {
			// A script rule reported offsets into the document. Computing the
			// position from them beats searching for the text, which lands on
			// the first copy when the match occurs more than once.
			//
			// Before the measurement case: a zero-width match has no text
			// either, but it does have a place.
			const [line, span] = this.offsetLoc(blk.context, a.span[0]!, a.span[1]!, pad);
			a.line = line;
			a.span = span;
		} else if (a.match === "" && this.locateMeasurement(a, blk, pad)) {
			// A measurement has no text to find; `locateMeasurement` placed it.
		} else if (
			blk.scope.startsWith("raw") &&
			a.match !== "" &&
			a.span[0]! >= 0 &&
			a.span[1]! <= blk.context.length &&
			blk.context.slice(a.span[0]!, a.span[1]!) === a.match
		) {
			// For `scope: raw` the block *is* the whole document, so the span is
			// already an offset into it, and the reported line needs no further
			// translation. Using it directly rather than re-searching avoids
			// landing on an earlier occurrence.
			const [line, span] = this.offsetLoc(blk.context, a.span[0]!, a.span[1]!, pad);
			a.line = line;
			a.span = span;
		} else {
			// For every other scope the block's text differs from the source, so
			// the span is not a usable offset; fall back to a text search. When
			// the match's text also occurs earlier in the block, the search must
			// skip those occurrences -- counted here, where the span and the
			// text share a coordinate system.
			//
			// A check that supplies its own `offset` words -- `sequence` names
			// the candidates it rejected -- keeps them; the two must not stack.
			if (
				(a.offset === undefined || a.offset.length === 0) &&
				a.match !== "" &&
				a.span[0]! >= 0 &&
				a.span[0]! <= blk.text.length
			) {
				a.skipOcc = countPrior(blk.text.slice(0, a.span[0]!), a.match);

				// An occurrence a prior alert already masked out of the context
				// is not there to skip past.
				if (a.skipOcc > 0) {
					a.skipOcc -= this.chkMasked[`${a.check}\u0000${a.match}`] ?? 0;
					if (a.skipOcc < 0) a.skipOcc = 0;
				}
			}

			if (!lookup) {
				const [line, span] = this.assignLoc(ctx, blk, pad, a);
				a.line = line;
				a.span = span;
			}
			if ((!lookup && a.span[0]! < 0) || lookup) {
				// An earlier alert's mask may have shortened `ctx`, so the
				// block's offset into its context is carried over to the copy.
				const at = maskedOffset(blk.context, ctx, blk.offset);
				const found = this.findLoc(ctx, blk.text, pad, lines, a, at);
				a.line = found.line;
				a.span = found.span;
				hit = found.hit;
			}
		}

		// A directive inside the block has already cancelled out of the toggles
		// `shouldRun` reads, but its recorded region still covers this
		// location. Hidden rather than dropped: the masking below must still
		// consume the occurrence, or the next alert from this check finds it
		// again.
		if (
			a.hide !== true &&
			this.regionDisabled(a.check, a.match, a.line, a.span[0]!)
		) {
			a.hide = true;
		}

		if (a.span[0]! <= 0) return;

		// Masking the text just reported keeps the *next* alert from this check
		// finding the same occurrence. An alert located by offset was never
		// found by searching, so there is nothing to mask -- and skipping it
		// avoids copying the whole context per alert.
		if (a.hasByteOffsets !== true) {
			this.chkToCtx[a.check] = maskMatch(ctx, a.match, hit);
			const key = `${a.check}\u0000${a.match}`;
			this.chkMasked[key] = (this.chkMasked[key] ?? 0) + 1;
		}

		if (a.hide === true) return;

		const entry = historyKey(a);
		if (this.history[entry] !== undefined) return;

		const count = this.limits[a.check];
		const limit = a.limit ?? 0;
		if (count !== undefined && limit !== 0 && count >= limit) return;

		this.alerts.push(a);
		this.history[entry] = 1;
		if (limit > 0) this.limits[a.check] = (this.limits[a.check] ?? 0) + 1;
	}

	/**
	 * Places an alert that has no text to find -- a measurement -- and reports
	 * whether it could.
	 *
	 * It lands at the start of its block's first line: the file's for the
	 * summary, the heading's for a section, the paragraph's for a paragraph.
	 * Two kinds of block are placed by where they begin instead. A sentence is
	 * the one block that can begin mid-line, and it carries its paragraph's
	 * line: reported there, every sentence after the first landed on a position
	 * already taken and was dropped as a duplicate. And a block with no line of
	 * its own has only its offset to say where it is.
	 */
	private locateMeasurement(a: Alert, blk: Block, pad: number): boolean {
		if (blk.scope.startsWith("sentence") || blk.line < 0) {
			const ctx = blk.context === "" ? this.content : blk.context;
			const at = blk.sourceOffset(0);
			if (at >= 0 && at < ctx.length) {
				const [line, span] = this.offsetLoc(ctx, at, at, pad);
				a.line = line;
				a.span = span;
				return true;
			}
		}
		if (blk.line >= 0 && blk.line < this.lines.length) {
			a.line = blk.line + 1;
			a.span = [1, 1];
			return true;
		}
		return false;
	}

	/**
	 * `locFromOffset` with the file's line index and a running column count.
	 *
	 * Alerts arrive in document order, so on a long line each count picks up
	 * where the last one stopped; counting from the line's start every time is
	 * quadratic on a paragraph written as one line.
	 */
	private offsetLoc(
		ctx: string,
		beginArg: number,
		end: number,
		pad: number,
	): [number, number[]] {
		const begin = Math.min(beginArg, ctx.length);
		const starts = this.lineStarts(ctx);
		const line = upperBound(starts, begin);
		const lineStart = starts[line - 1]!;

		// A count can only continue from a character boundary: split inside
		// one, and the two halves each count as a character.
		if (
			this.colCtx !== ctx ||
			this.colLine !== lineStart ||
			begin < this.colAt ||
			(this.colAt < ctx.length && isLowSurrogate(ctx.charCodeAt(this.colAt)))
		) {
			this.colCtx = ctx;
			this.colLine = lineStart;
			this.colAt = lineStart;
			this.colChars = 0;
		}
		this.colChars += strLen(ctx.slice(this.colAt, begin));
		this.colAt = begin;

		return [line, spanAt(ctx, this.colChars + 1 + pad, begin, end)];
	}

	/**
	 * Places an alert by looking for the line whose text at the reported span
	 * is the match, or failing that the line the block says it is on.
	 */
	private assignLoc(
		ctx: string,
		blk: Block,
		pad: number,
		a: Alert,
	): [number, number[]] {
		const loc = a.span;
		const lines = splitAfterLines(ctx);

		for (let idx = 0; idx < lines.length; idx++) {
			const l = lines[idx]!;
			if (loc[0]! < 0 || loc[1]! < 0) continue;

			const exact = l.length > loc[1]! && l.slice(loc[0]!, loc[1]!) === a.match;
			if (!exact && idx !== blk.line) continue;

			const length = strLen(l);
			// Mask the words preceding the match -- computed in `addAlert` when
			// the token occurs more than once -- so the re-search below lands on
			// the right occurrence.
			let masked = l;
			for (const s of a.offset ?? []) {
				[masked] = substitute(masked, s, "@");
			}
			// No offset hint: `masked` is a single line, so the block's own
			// offset is measured against something else entirely.
			const [pos, substring] = initialPosition(
				masked,
				blk.text,
				a,
				segmentText,
				tokenizeWords,
			);

			loc[0] = pos + pad;
			loc[1] = pos + strLen(substring) - 1;

			const extent = length + pad;
			if (loc[1]! > extent) loc[1] = extent;
			else if (loc[1]! <= 0) loc[1] = 1;

			return [idx + 1, loc];
		}

		return [blk.line + 1, a.span];
	}

	/**
	 * The line and span of an alert, found by searching the context.
	 *
	 * `at` is where the block's text begins in `ctx`, or -1 when that is not
	 * known; it lets the match be placed without searching for it.
	 */
	private findLoc(
		ctxArg: string,
		s: string,
		pad: number,
		count: number,
		a: Alert,
		atArg: number,
	): { line: number; span: number[]; hit: number } {
		let ctx = ctxArg;
		const given = ctx;
		for (const off of a.offset ?? []) {
			[ctx] = substitute(ctx, off, "@");
		}
		const at = maskedOffset(given, ctx, atArg);

		const found = locateMatch(ctx, s, a, at, segmentText, tokenizeWords);
		if (found.column < 0) {
			// Should not happen; reported as unplaceable rather than guessed.
			return { line: found.column, span: [0, 0], hit: -1 };
		}
		let hit = found.hit;
		if (hit >= 0) {
			// The `offset` masks above map character to character; the tail
			// keeps its place.
			hit += given.length - ctx.length;
		}

		const loc = a.span;
		const lines =
			(this.format === "markup" && !this.simple) || this.format === "fragment"
				? this.lines
				: splitAfterLines(ctx);

		let counter = 0;
		for (let idx = 0; idx < lines.length; idx++) {
			const length = strLen(lines[idx]!);
			if (counter + length >= found.column) {
				loc[0] = found.column - counter + pad;
				loc[1] = loc[0]! + strLen(found.text) - 1;
				const extent = length + pad;
				if (loc[1]! > extent) loc[1] = extent;
				else if (loc[1]! <= 0) loc[1] = 1;
				return { line: count - (lines.length - (idx + 1)), span: loc, hit };
			}
			counter += length;
		}

		return { line: count, span: loc, hit };
	}
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Identifies an alert by where it was reported. */
function historyKey(a: Alert): string {
	return `${a.line}-${a.span[0]}-${a.check}`;
}

/**
 * Reads a file and works out which rules apply to it.
 *
 * `src` is a path when the file exists and the text itself otherwise, which is
 * how linting from stdin works.
 */
export function newFile(src: string, config: Config): File {
	let ext: string;
	let format: string;
	let content: string;
	let lookup = false;
	let path = src;

	if (fileExists(src)) {
		content = readFileSync(src, "utf8");
		if (config.flags.inExt !== ".txt") {
			[ext, format] = formatFromExt(config.flags.inExt, config.formats);
		} else {
			[ext, format] = formatFromExt(src, config.formats);
		}
	} else {
		content = src;
		lookup = true;
		// For stdin, an explicit path override drives the path-based parts of
		// the configuration.
		path =
			config.flags.inPath !== ""
				? config.flags.inPath
				: `stdin${config.flags.inExt}`;
		// An explicit `--ext` wins; otherwise the format comes from the path.
		if (config.flags.inExt !== ".txt") {
			[ext, format] = formatFromExt(config.flags.inExt, config.formats);
		} else {
			[ext, format] = formatFromExt(path, config.formats);
		}
	}

	const normed = normalizePathFormat(path, config.formats);

	// A conditional section applies only where its condition holds; every
	// lookup below asks `sectionApplies`.
	let held: Record<string, boolean>;
	try {
		held = config.heldConditions(path, content);
	} catch (err) {
		throw newE201FromPosition(
			err instanceof Error ? err.message : String(err),
			path,
			1,
		);
	}

	let baseStyles = config.gBaseStyles;
	// Which section set `baseStyles`, so that a section replacing a package's
	// list can say which package it came from. "" is the top level.
	let styledBy = "";
	let checks: Record<string, boolean> = {};
	let levels: Record<string, string> = {};
	let unset: Record<string, boolean> = {};
	const vocab: string[] = [];

	// `[*]` names vocabularies for every file; their rules are global.
	vocab.push(...(config.sVocab["*"] ?? []));

	// Sections are visited in the order they were written, so a later one wins
	// -- for this file, and no other.
	for (const sec of config.ruleKeys) {
		if (!config.sectionApplies(sec, held, path)) continue;

		const styles = config.sBaseStyles[sec];
		if (styles !== undefined) {
			warnDroppedStyles(config, sec, styledBy, baseStyles, styles);
			baseStyles = styles;
			styledBy = sec;
			if (styles.length === 0) {
				// `BasedOnStyles =` says nothing runs here: earlier sections no
				// longer apply, and global settings are off.
				checks = {};
				levels = {};
				unset = {};
				for (const k of Object.keys(config.gChecks)) checks[k] = false;
			}
		}

		for (const [k, v] of Object.entries(config.sChecks[sec] ?? {})) {
			checks[k] = v;
			delete unset[k];
		}
		for (const [k, v] of Object.entries(config.sLevels[sec] ?? {})) {
			levels[k] = v;
		}
		for (const k of config.sUnsets[sec] ?? []) {
			delete checks[k];
			delete levels[k];
			unset[k] = true;
		}
		for (const name of config.sVocab[sec] ?? []) {
			if (!vocab.includes(name)) vocab.push(name);
			checks[`Vale.${name}.Terms`] = true;
			checks[`Vale.${name}.Avoid`] = true;
		}
	}

	let lang = "en";
	const globalLang = config.formatToLang["*"];
	if (globalLang !== undefined && globalLang !== "") lang = globalLang;
	for (const sec of config.ruleKeys) {
		if (!config.sectionApplies(sec, held, path)) continue;
		const code = config.formatToLang[sec];
		if (code !== undefined) lang = code;
	}

	let transform = config.stylesheets["*"] ?? "";
	for (const sec of config.ruleKeys) {
		if (!config.sectionApplies(sec, held, path)) continue;
		const p = config.stylesheets[sec];
		if (p !== undefined) transform = p;
	}

	const sanitized = sanitize(content);

	const file = new File(newNLPInfo({ endpoint: config.nlpEndpoint, lang }));
	file.normedExt = ext;
	file.format = format;
	file.realExt = extName(path);
	file.baseStyles = baseStyles;
	file.checks = checks;
	file.levels = levels;
	file.unset = unset;
	file.vocab = vocab;
	file.content = sanitized;
	// A clone of the content, because the readers edit the text in place and
	// those edits must not be reflected in `lines`.
	file.lines = splitAfterLines(sanitized);
	file.transform = transform;
	file.held = held;
	file.path = path;
	file.lookup = lookup;
	file.normedPath = normed;
	setPrivate(file, "simple", config.flags.simple);
	setPrivate(file, "sanShifts", findShifts(content));

	return file;
}

/** Writes a private field during construction, which the class guards. */
function setPrivate(file: File, key: string, value: unknown): void {
	(file as unknown as Record<string, unknown>)[key] = value;
}

export { nodePath };
