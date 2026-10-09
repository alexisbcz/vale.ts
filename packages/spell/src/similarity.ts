/**
 * How close two spellings are, which is what orders suggestions.
 *
 * This is the Levenshtein metric as `github.com/adrg/strutil` computes it,
 * reproduced rather than approximated: the suggester's output order, and the
 * floors the tests hold it to, are the scores this returns.
 */

import { runes } from "./text.ts";

/** The costs `strutil`'s Levenshtein metric is created with. */
const INSERT_COST = 1;
const DELETE_COST = 1;
const REPLACE_COST = 1;

/**
 * The edit distance between `a` and `b`, in code points.
 *
 * Also returns the length the similarity is measured against, which is the
 * longer of the two and is 0 only when both are empty.
 */
function measure(a: string, b: string): [number, number] {
	const ra = runes(a);
	const rb = runes(b);
	const lenA = ra.length;
	const lenB = rb.length;
	if (lenA === 0 && lenB === 0) return [0, 0];

	const maxLen = Math.max(lenA, lenB);
	if (lenA === 0) return [INSERT_COST * lenB, maxLen];
	if (lenB === 0) return [DELETE_COST * lenA, maxLen];

	let prev = new Array<number>(lenB + 1);
	for (let i = 0; i <= lenB; i++) prev[i] = INSERT_COST * i;

	let col = new Array<number>(lenB + 1);
	for (let i = 0; i < lenA; i++) {
		col[0] = DELETE_COST * (i + 1);
		for (let j = 0; j < lenB; j++) {
			const del = (prev[j + 1] as number) + DELETE_COST;
			const ins = (col[j] as number) + INSERT_COST;
			let sub = prev[j] as number;
			if (ra[i] !== rb[j]) sub += REPLACE_COST;
			col[j + 1] = Math.min(del, ins, sub);
		}
		const swap = prev;
		prev = col;
		col = swap;
	}
	return [prev[lenB] as number, maxLen];
}

/** The edit distance between two spellings; 0 means they are identical. */
export function distance(a: string, b: string): number {
	return measure(a, b)[0];
}

/**
 * The closeness of two spellings, from 0 to 1, as the suggester measures it.
 *
 * Two empty strings give NaN, as they do in Go, where the ratio is 0/0; no
 * caller asks.
 */
export function similarity(a: string, b: string): number {
	const [dist, maxLen] = measure(a, b);
	return 1 - dist / maxLen;
}
