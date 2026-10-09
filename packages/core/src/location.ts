/**
 * Turning a match into a line and a column.
 *
 * A check reports where in its *block* a match was; the user needs where in
 * the *file* it was. Those are not the same coordinate system -- extraction
 * drops markup, the sanitizer rewrites an entity, an earlier alert has masked
 * part of the text -- so the block's span is a hint, checked before it is
 * trusted, with a search through the source as the fallback.
 *
 * The subtlety is all in which occurrence wins. A word that appears three
 * times in a paragraph produces three alerts, and each has to land on its own
 * copy: hence the masking of text already reported, the count of acceptable
 * occurrences preceding a match, and the refusal to settle on a candidate that
 * sits inside inline code.
 */

import type { Alert } from "./alert.ts";
import { strLen, substitute } from "./util.ts";

/** Whether `s` holds no letters or digits -- a bare `,`, say. */
export function isPunctOnly(s: string): boolean {
	for (const r of s) {
		if (/[\p{L}\p{Nd}]/u.test(r)) return false;
	}
	return s !== "";
}

/**
 * Whether `r` would sit inside a word, and so cannot stand beside a match the
 * search requires to be boundary-bounded.
 *
 * `_` is a word character to the regular-expression engine, but the pattern
 * below admits it as a boundary of its own, so it is not one of these.
 */
function joinsWord(r: string): boolean {
	return /[\p{L}\p{Nd}]/u.test(r);
}

/** The character at `i`, which may be a surrogate pair. */
function charAt(s: string, i: number): string {
	const cp = s.codePointAt(i);
	return cp === undefined ? "" : String.fromCodePoint(cp);
}

/** The character ending at `i`. */
function charBefore(s: string, i: number): string {
	if (i <= 0) return "";
	const code = s.charCodeAt(i - 1);
	if (code >= 0xdc00 && code <= 0xdfff && i >= 2) {
		const high = s.charCodeAt(i - 2);
		if (high >= 0xd800 && high <= 0xdbff) return s.slice(i - 2, i);
	}
	return s[i - 1]!;
}

/** Whether a match starting at `at` sits on a boundary. */
function boundaryBefore(ctx: string, at: number, first: string): boolean {
	if (at === 0) return true;
	const prev = charBefore(ctx, at);
	if (prev === "_") return true;
	return joinsWord(prev) !== joinsWord(first);
}

/** Whether a match ending at `at` sits on a boundary. */
function boundaryAfter(ctx: string, at: number, last: string): boolean {
	if (at >= ctx.length) return true;
	const next = charAt(ctx, at);
	if (next === "_") return true;
	return joinsWord(next) !== joinsWord(last);
}

/**
 * The first occurrence of `sub` in `ctx` that the search would accept, after
 * skipping `skip` acceptable ones.
 *
 * A candidate inside inline markup is neither counted nor returned; it is what
 * the search is trying not to land on.
 *
 * The search pattern is `(?:^|\b|_)` + sub + `(?:_|\b|$)`. When `sub` holds no
 * quotes it is a plain literal, so the same answer comes from a literal search
 * plus a boundary test at each hit -- and the literal search is the fast one.
 */
export function literalNth(ctx: string, sub: string, skipArg: number): number {
	if (sub === "") return -1;
	let skip = skipArg;

	const first = charAt(sub, 0);
	const last = charBefore(sub, sub.length);

	for (let i = 0; ; ) {
		const at = ctx.indexOf(sub, i);
		if (at < 0) return -1;

		if (
			boundaryBefore(ctx, at, first) &&
			boundaryAfter(ctx, at + sub.length, last) &&
			!insideInlineMarkup(ctx, [at, at + sub.length])
		) {
			if (skip === 0) return at;
			skip--;
		}
		// Advancing by one character rather than by the length of `sub`:
		// overlapping candidates are rare but real, and skipping them would
		// miss a valid match.
		i = at + charAt(ctx, at).length;
	}
}

/**
 * How many occurrences of `sub` in `text` the search would accept.
 *
 * Judged the same way `literalNth` judges its candidates -- an occurrence the
 * search would never land on must not widen the skip.
 */
export function countPrior(text: string, sub: string): number {
	if (sub === "") return 0;

	const first = charAt(sub, 0);
	const last = charBefore(sub, sub.length);

	let found = 0;
	for (let i = 0; ; ) {
		const at = text.indexOf(sub, i);
		if (at < 0) return found;

		if (
			boundaryBefore(text, at, first) &&
			boundaryAfter(text, at + sub.length, last) &&
			!insideInlineMarkup(text, [at, at + sub.length])
		) {
			found++;
		}
		i = at + charAt(text, at).length;
	}
}

/**
 * Escapes `s` for use in a pattern, but lets a straight quote also match its
 * curly variant.
 *
 * Spell-checking normalizes `’` to `'` before matching, so the match it
 * reports has to stay findable in the source, which was never normalized.
 */
export function quoteTolerantPattern(s: string): string {
	let out = "";
	for (const r of s) {
		switch (r) {
			case "'":
				out += "['‘’]";
				break;
			case '"':
				out += '["“”]';
				break;
			case "\n":
				// A line break in a match is a break in the block's text; in the
				// source it may be followed by a list item's indentation or a
				// blockquote's `>`, which the block's text does not carry.
				out += "\\n(?:[ \\t]|>)*";
				break;
			default:
				out += /[.*+?^${}()|[\]\\]/.test(r) ? `\\${r}` : r;
				break;
		}
	}
	return out;
}

/**
 * Whether a match sits against a backtick, a dash or a math delimiter, which
 * is how a match inside inline markup is recognized.
 *
 * Ideally this would be handled at the tree level by skipping inline code
 * spans; it is a workaround, and the comments below record which cases it has
 * had to learn about.
 */
export function insideInlineMarkup(ctx: string, fs: number[]): boolean {
	const start = fs[0]! - 1;
	const end = fs[1]! + 1;

	if (start > 0 && (ctx[start] === "`" || ctx[start] === "-")) return true;

	if (
		end < ctx.length &&
		(ctx[end] === "`" || ctx[end] === "-") &&
		!/\s/.test(ctx[fs[1]!] ?? "")
	) {
		// `end` looks one past the character beside the match, catching a
		// closing backtick separated by punctuation. When the character between
		// is whitespace, though, the backtick *opens* a span after the match --
		// "word `code`" is prose sitting before code, and rejecting it hands
		// the alert to a later occurrence.
		return true;
	}

	// `fs[1]` is exclusive, so the character right beside the match is
	// `ctx[fs[1]]` -- the test above looks one further out and misses a closing
	// backtick sitting directly against the match. Backticks only: a hyphen
	// there is usually a compound word, and rejecting `well` in `well-known`
	// would mislocate it.
	if (fs[1]! < ctx.length && ctx[fs[1]!] === "`") return true;

	// `$…$` inline math is skipped the same way inline code is, so a match
	// pressed against a delimiter is markup rather than the prose that fired.
	if (fs[0]! > 0 && ctx[fs[0]! - 1] === "$") return true;
	if (fs[1]! < ctx.length && ctx[fs[1]!] === "$") return true;

	return false;
}

/**
 * Confirms that `idx` is where the search below would land, so that the search
 * itself can be skipped.
 *
 * A check knows where in its block the match was, and the block knows where it
 * begins in `ctx`, so the position is arithmetic. That matters because the
 * search runs once per alert over the whole context, and spelling reports
 * alerts by the thousand -- the difference between linear and quadratic on a
 * large document.
 *
 * The arithmetic rests on hints rather than promises, though, so the answer is
 * only used when the text there really is the match, bounded as the pattern
 * requires, with nothing before it the pattern would have matched first.
 * `from` is where that last check has to start. Anything short of all three
 * falls through to the search, which makes a bad hint cost time rather than
 * correctness.
 */
export function directPosition(
	ctx: string,
	idx: number,
	from: number,
	sub: string,
): boolean {
	// Quote tolerance and the `^`/`$`/`_` alternatives make the pattern's
	// boundaries subtle in both directions. Restricting this to matches that
	// begin and end on a letter or digit and hold no quotes covers the ordinary
	// word -- what spelling reports -- and leaves the rest to the search.
	if (sub === "" || from < 0 || idx < from || /['"]/.test(sub)) return false;
	if (!joinsWord(charAt(sub, 0))) return false;
	if (!joinsWord(charBefore(sub, sub.length))) return false;

	const end = idx + sub.length;
	if (end > ctx.length || ctx.slice(idx, end) !== sub) return false;

	if (idx > 0 && joinsWord(charBefore(ctx, idx))) return false;
	if (end < ctx.length && joinsWord(charAt(ctx, end))) return false;

	// The search reports the *first* acceptable match, so this agrees with it
	// only if there is nothing earlier to find. A plain scan is enough: `sub`
	// holds no quote for the pattern to be tolerant about, so the pattern can
	// only match where `sub` itself occurs.
	return !ctx.slice(from, idx).includes(sub);
}

/**
 * Whether `ctx` begins with `txt`, a masked character standing for any one.
 *
 * Character by character: a mask keeps the character count, not the byte
 * count, since a multi-byte character is masked as a single `#`.
 */
export function throughMask(ctxArg: string, txt: string): boolean {
	let ctx = ctxArg;
	for (const want of txt) {
		if (ctx === "") return false;
		const got = charAt(ctx, 0);
		if (got !== want && got !== "#" && got !== "@") return false;
		ctx = ctx.slice(got.length);
	}
	return true;
}

/**
 * Maps the offset `at` in `ctx` to the same character in `masked`, a copy of
 * `ctx` that masking has shortened.
 *
 * The characters still line up, so the offset is carried over by counting them.
 */
export function maskedOffset(ctx: string, masked: string, at: number): number {
	if (at <= 0 || at > ctx.length || ctx.length === masked.length) return at;
	let chars = strLen(ctx.slice(0, at));
	for (let i = 0; i < masked.length; ) {
		if (chars === 0) return i;
		chars--;
		i += charAt(masked, i).length;
	}
	return masked.length;
}

/** A located match: its 1-based column, its text, and where it was found. */
export interface Located {
	column: number;
	text: string;
	/** The index in the unmasked context, or -1 when it was guessed. */
	hit: number;
}

function located(ctx: string, idxArg: number, sub: string, shift: number): Located {
	let idx = idxArg;
	if (ctx.slice(idx).startsWith("_")) idx++;
	return { column: strLen(ctx.slice(0, idx)) + 1, text: sub, hit: idx + shift };
}

/**
 * Masks the match at `hit` in `ctx`, character for character, or its first
 * occurrence when `hit` is not where it was found.
 */
export function maskMatch(ctx: string, matchArg: string, hit: number): string {
	let match = matchArg;
	let end = hit + match.length;

	if (
		hit >= 0 &&
		hit <= ctx.length &&
		match.includes("\n") &&
		(end > ctx.length || ctx.slice(hit, end) !== match)
	) {
		// A wrapped match reads past the source's indentation or quote markers,
		// so the text at `hit` is longer than the match.
		const pat = new RegExp(`^${quoteTolerantPattern(match)}`, "u");
		const m = pat.exec(ctx.slice(hit));
		if (m !== null) {
			end = hit + m[0].length;
			match = ctx.slice(hit, end);
		}
	}

	if (hit < 0 || end > ctx.length || ctx.slice(hit, end) !== match) {
		const [masked] = substitute(ctx, match, "#");
		return masked;
	}

	let blanked = "";
	for (const r of match) blanked += r === "\n" ? "\n" : "#";
	return ctx.slice(0, hit) + blanked + ctx.slice(end);
}

/**
 * Where a match sits in the source document.
 *
 * `ctx` is the source, `txt` is the block's text, and `a.match` is what the
 * rule found inside it. `at` is where the block begins in `ctx` if the caller
 * knows, and -1 otherwise -- a shortcut, since the position it produces is
 * checked before being used.
 */
export function locateMatch(
	ctxArg: string,
	txt: string,
	a: Alert,
	at: number,
	segment: (text: string) => string[],
	tokenize: (text: string) => string[],
): Located {
	let ctx = ctxArg;

	if (a.match === "") {
		// Nothing to look for: assume the rule applies to the whole document,
		// as a readability measurement does.
		return { column: 1, text: "", hit: -1 };
	}

	let offset = ctx.indexOf(txt);
	if (offset < 0 && isPunctOnly(a.match)) {
		// `txt` may not appear verbatim in `ctx` when inline markup was
		// stripped during extraction. For a punctuation-only match -- which
		// occurs all over the document -- anchor on the block's first token so
		// that everything before it is still masked; otherwise a bare `,` is
		// located at its first occurrence anywhere.
		const fields = txt.split(/\s+/).filter((f) => f !== "");
		if (fields.length > 0) offset = ctx.indexOf(fields[0]!);
	}

	// The reader placed the block; trust that over an earlier copy of its text,
	// which is what a repeated table header or heading is. Earlier alerts have
	// masked their matches, so the text is read through the mask.
	if (at >= 0 && at <= ctx.length && throughMask(ctx.slice(at), txt)) {
		offset = at;
	}

	// The prefix mask below maps character to character, so a prefix holding
	// anything multi-byte comes back shorter; `shift` maps an index in the
	// masked text back to `ctx` as given.
	let shift = 0;
	if (offset >= 0) {
		const [masked] = substitute(ctx, ctx.slice(0, offset), "@");
		// The tail it leaves alone is what gives the block its new position.
		offset = masked.length - (ctx.length - offset);
		shift = ctx.length - masked.length;
		ctx = masked;
	}

	const sub = a.match;

	// Where the block starts in `ctx`, and how far the pattern is already known
	// to have nothing to match. The search above answers both at once. When it
	// came up empty -- which is what happens once an earlier alert has masked
	// part of this block, so on every alert but the first -- the caller's
	// offset still says where the block is, but nothing has ruled out the text
	// in front of it, so that has to be scanned as well.
	let base = offset;
	let from = offset;
	if (base < 0) {
		base = at;
		from = 0;
	}

	if (base >= 0 && a.span.length > 0 && a.span[0]! >= 0) {
		const pos = base + a.span[0]!;
		if (directPosition(ctx, pos, from, sub)) {
			// The span the pattern would have reported, so that the inline-code
			// test below sees what it sees: both `_` alternatives are consumed
			// by the match rather than left beside it.
			const fs = [pos, pos + sub.length];
			if (pos > 0 && ctx[pos - 1] === "_") fs[0]!--;
			if (fs[1]! < ctx.length && ctx[fs[1]!] === "_") fs[1]!++;
			if (!insideInlineMarkup(ctx, fs)) return located(ctx, pos, sub, shift);
		}
	}

	const pat = new RegExp(
		`(?:^|\\b|_)${quoteTolerantPattern(sub)}(?:_|\\b|$)`,
		"gu",
	);

	// The match may be preceded, within its own block, by copies of its text;
	// the search skips exactly that many acceptable candidates so that a
	// repeated word resolves to the occurrence that actually matched.
	let skip = a.skipOcc ?? 0;

	// Only the first acceptable match is used, so the search stops at the first
	// one and widens only if that turns out to be rejected below. A quote-free
	// match is a plain literal, so the first candidate can be found without
	// running the engine over the whole context.
	if (!/['"]/.test(sub)) {
		const lit = literalNth(ctx, sub, skip);
		if (lit >= 0) return located(ctx, lit, sub, shift);
	}

	const fsi: number[][] = [];
	pat.lastIndex = 0;
	for (;;) {
		const m = pat.exec(ctx);
		if (m === null) break;
		fsi.push([m.index, m.index + m[0].length]);
		if (m[0].length === 0) pat.lastIndex++;
	}

	if (fsi.length > 0 && skip === 0 && !insideInlineMarkup(ctx, fsi[0]!)) {
		return located(ctx, fsi[0]![0]!, sub, shift);
	}

	let idx: number;
	if (fsi.length === 0) {
		idx = ctx.indexOf(sub);
		if (idx < 0) {
			// Only reachable in a scope holding inline markup -- a sentence with
			// code spans, say.
			const guess = guessLocation(ctx, txt, sub, segment, tokenize);
			return { column: guess[0], text: guess[1], hit: -1 };
		}
	} else {
		idx = fsi[0]![0]!;
		// Where there is more than one match, skip the ones that look like they
		// sit inside inline code.
		for (const fs of fsi) {
			if (insideInlineMarkup(ctx, fs)) continue;
			if (skip > 0) {
				skip--;
				continue;
			}
			idx = fs[0]!;
			break;
		}
	}

	return located(ctx, idx, sub, shift);
}

/** `locateMatch` without the index, for a caller that only needs the column. */
export function initialPosition(
	ctx: string,
	txt: string,
	a: Alert,
	segment: (text: string) => string[],
	tokenize: (text: string) => string[],
): [number, string] {
	const found = locateMatch(ctx, txt, a, -1, segment, tokenize);
	return [found.column, found.text];
}

/**
 * A last resort for a match whose text is nowhere in the context: find the
 * sentence it belongs to and then the source line holding that sentence's
 * words.
 */
function guessLocation(
	ctx: string,
	sub: string,
	match: string,
	segment: (text: string) => string[],
	tokenize: (text: string) => string[],
): [number, string] {
	let target = "";
	for (const s of segment(sub)) {
		if (s === match || s.indexOf(match) > 0) target = s;
	}
	if (target === "") return [-1, sub];

	const tokens = tokenize(target);
	for (const text of ctx.split("\n")) {
		if (tokens.every((t) => text.includes(t))) {
			return [ctx.indexOf(text) + 1, text];
		}
	}

	return [-1, sub];
}

/**
 * The 1-based line and `[column, column + length]` span for an absolute offset
 * into the document.
 *
 * `starts` is the offset at which each line begins, which the caller builds
 * once per document: counting newlines per alert is a scan of the whole
 * document each time, and alert count grows with document size.
 */
export function locFromOffset(
	ctx: string,
	starts: readonly number[],
	beginArg: number,
	end: number,
	pad: number,
): [number, number[]] {
	const begin = Math.min(beginArg, ctx.length);

	// The line is the number of starts at or before `begin`, which is already
	// 1-based because every document starts a line at offset 0.
	const line = upperBound(starts, begin);
	const lineStart = starts[line - 1]!;

	return [
		line,
		spanAt(ctx, strLen(ctx.slice(lineStart, begin)) + 1 + pad, begin, end),
	];
}

/** The span of a match at column `col` running from `begin` to `end`. */
export function spanAt(
	ctx: string,
	col: number,
	begin: number,
	end: number,
): number[] {
	const span = [col, col + strLen(ctx.slice(begin, end)) - 1];
	if (span[1]! < span[0]!) span[1] = span[0]!;
	return span;
}

/** The number of entries in the sorted `starts` that are at or before `at`. */
export function upperBound(starts: readonly number[], at: number): number {
	let lo = 0;
	let hi = starts.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (starts[mid]! > at) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** The offset at which each line of `ctx` begins. */
export function lineStarts(ctx: string): number[] {
	const starts = [0];
	for (let i = 0; i < ctx.length; i++) {
		if (ctx[i] === "\n") starts.push(i + 1);
	}
	return starts;
}
