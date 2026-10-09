/**
 * Pairing quotation marks.
 *
 * Quotations are prose no format marks up: to Markdown, a line of dialogue is
 * characters in a paragraph. They are paired here by their marks, the way a
 * reader pairs them, for the `quote` scope and the `quote_words` metric. The
 * marks stay inside the quotation.
 *
 * An opening mark with no closing mark runs to the end of its paragraph, which
 * is the convention for speech that continues into the next one.
 */

import {
	decodeLastRune,
	decodeRune,
	fields,
	isDigit,
	isLetter,
	runeIsSpace,
} from "./util.ts";

/** Maps an opening quotation mark to the mark that closes it. */
const quoteClosers = new Map<number, number>([
	[0x201c, 0x201d], // “ ”
	[0x22, 0x22], // " "
	[0x2018, 0x2019], // ‘ ’
]);

const RIGHT_SINGLE = 0x2019;

/** Where an opening mark was found, and what closes it. */
export interface OpeningMark {
	/** Where the mark begins, or -1 when there is none. */
	at: number;
	/** The mark's width. */
	size: number;
	/** The code point that closes it. */
	closer: number;
}

/**
 * Finds the first opening mark in `s` at or after `from`.
 *
 * A straight mark opens only after a space, a bracket, or a dash, since the
 * same character closes and doubles as an inch sign.
 */
export function openingQuote(s: string, from: number): OpeningMark {
	for (let i = from; i < s.length; ) {
		const [r, size] = decodeRune(s, i);
		if (size === 0) break;
		const closer = quoteClosers.get(r);
		if (closer !== undefined && opensQuote(s, i, r)) {
			return { at: i, size, closer };
		}
		i += size;
	}
	return { at: -1, size: 0, closer: 0 };
}

function opensQuote(s: string, at: number, mark: number): boolean {
	if (at === 0) return true;
	const [prev] = decodeLastRune(s, at);
	const ch = String.fromCodePoint(prev);
	if (mark === 0x22) {
		return runeIsSpace(prev) || "([{—–-/".includes(ch);
	}
	return !isLetter(ch) && !isDigit(ch);
}

/**
 * Finds the mark that closes a quotation in `s` at or after `from`, returning
 * the index just past it, or -1.
 *
 * A curly single mark is also an apostrophe: it closes only when no letter
 * follows it, so "don’t" and "Kenny’s" stay inside the quotation.
 */
export function closingQuote(s: string, closer: number, from: number): number {
	for (let i = from; i < s.length; ) {
		const [r, size] = decodeRune(s, i);
		if (size === 0) break;
		if (r === closer) {
			const [next] = decodeRune(s, i + size);
			if (closer !== RIGHT_SINGLE || !isLetter(String.fromCodePoint(next || 0))) {
				return i + size;
			}
		}
		i += size;
	}
	return -1;
}

/**
 * The ranges of the quotations in plain text, marks included.
 *
 * Pairing runs paragraph by paragraph.
 */
export function quoteSpans(s: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	let i = 0;
	while (i < s.length) {
		const { at, size, closer } = openingQuote(s, i);
		if (at < 0) break;

		let stop = s.length;
		const j = s.slice(at).indexOf("\n\n");
		if (j >= 0) stop = at + j;

		let end = closingQuote(s.slice(0, stop), closer, at + size);
		if (end < 0) end = stop;

		spans.push([at, end]);
		i = end;
	}
	return spans;
}

/** Counts the words inside the quotations of `s`. */
export function quotedWords(s: string): number {
	let n = 0;
	for (const [from, to] of quoteSpans(s)) {
		n += fields(s.slice(from, to)).length;
	}
	return n;
}
