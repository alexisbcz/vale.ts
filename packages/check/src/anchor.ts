/**
 * Turning a block-relative span into an absolute one within the document.
 *
 * Vale otherwise locates an alert by searching the document for the text it
 * matched, and masking that text so the next alert from the same rule finds a
 * later occurrence. That copies the whole context per alert, which is the bulk
 * of Vale's allocation on a document with many findings -- and it mislocates a
 * match that appears more than once or that spans irregular whitespace.
 *
 * An anchored alert needs none of that: it already says exactly where it is.
 *
 * Anchoring is skipped unless the block's position is known *and* verifiable.
 * Blocks carved out of markup hold text that has been stripped of its markup,
 * so their offsets do not address the original document; checking that the
 * text really sits where the offset claims is what keeps those out.
 */

import type { Alert, Block } from "@vale-ts/core";

export function anchor(a: Alert, blk: Block): void {
	if (a.span.length !== 2) return;

	const [lo, hi, ok] = blk.byteSpan(a.span[0]!, a.span[1]!);
	if (!ok) return;

	if (blk.offset < 0) {
		// A block that inline markup has rewritten -- `has <b>has</b>` read as
		// `has has` -- is nowhere in the document to be found, but each of its
		// runs was placed as it was read, and that is enough to say where the
		// match is. The span reaches from the first character to the last,
		// markup between them included, because that is its extent in the file.
		if (lo === hi) {
			// An empty match has no last character: it sits before the one at
			// `lo`, or after the final one when it is at the end.
			let at = blk.sourceOffset(lo);
			if (at < 0 && lo > 0) {
				const p = blk.sourceOffset(lo - 1);
				if (p >= 0) at = p + 1;
			}
			if (at < 0) return;
			a.span = [at, at];
			a.hasByteOffsets = true;
			return;
		}

		const from = blk.sourceOffset(lo);
		const to = blk.sourceOffset(hi - 1);
		if (from < 0 || to < from) return;
		a.span = [from, to + 1];
		a.hasByteOffsets = true;
		return;
	}

	// The offset is only ever set after a successful search for this text, so
	// it is already known good. It cannot be re-checked here: extraction masks
	// text in the context buffer as it goes, so by now the characters at that
	// position may have been overwritten -- length-preservingly, which is what
	// keeps the offset itself valid.
	if (blk.offset + blk.text.length > blk.context.length) return;

	a.span = [blk.offset + lo, blk.offset + hi];
	a.hasByteOffsets = true;
}

/**
 * Bounds-checks a span of `s`.
 *
 * Go converts a rune-indexed span into byte offsets here, because its
 * regular-expression engine reports runes while its strings are indexed in
 * bytes. This port has one offset unit, the string index, so there is nothing
 * to convert -- only the check that the span fits, which the callers rely on.
 */
export function runeSpanToBytes(
	s: string,
	from: number,
	to: number,
): [number, number, boolean] {
	if (from < 0 || to < from || to > s.length) return [0, 0, false];
	return [from, to, true];
}
