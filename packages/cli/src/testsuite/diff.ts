/**
 * The line diff a failing test case is reported with.
 *
 * A failing case is nearly always a line that moved by a column or a message
 * that was reworded, and neither reads as two blocks of text quoted one after
 * the other. Rendering is the caller's -- what color a `-` is, and how far it
 * is indented, is a question about where it is being printed.
 */

/** What a diff line did. */
export const Same = " ";
export const Del = "-";
export const Add = "+";

/** One line of a diff. */
export interface Line {
	op: string;
	text: string;
}

/** Compares `want` against `got`, line by line. */
export function diff(want: string, got: string): Line[] {
	const w = split(want);
	const g = split(got);
	const common = lcs(w, g);

	const out: Line[] = [];
	let i = 0;
	let j = 0;

	for (const c of common) {
		while (i < w.length && w[i] !== c) out.push({ op: Del, text: w[i++] as string });
		while (j < g.length && g[j] !== c) out.push({ op: Add, text: g[j++] as string });
		out.push({ op: Same, text: c });
		i++;
		j++;
	}

	for (; i < w.length; i++) out.push({ op: Del, text: w[i] as string });
	for (; j < g.length; j++) out.push({ op: Add, text: g[j] as string });

	return out;
}

/**
 * The lines of `s`, without the trailing newline that would otherwise show up
 * as a line neither side has.
 */
function split(s: string): string[] {
	const trimmed = s.replace(/\n+$/, "");
	return trimmed === "" ? [] : trimmed.split("\n");
}

/** The longest common subsequence of `a` and `b`. */
function lcs(a: readonly string[], b: readonly string[]): string[] {
	const table: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);

	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			const row = table[i] as number[];
			const nextRow = table[i + 1] as number[];
			row[j] =
				a[i] === b[j]
					? (nextRow[j + 1] as number) + 1
					: Math.max(nextRow[j] as number, row[j + 1] as number);
		}
	}

	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push(a[i] as string);
			i++;
			j++;
		} else if (
			((table[i + 1] as number[])[j] as number) >=
			((table[i] as number[])[j + 1] as number)
		) {
			i++;
		} else {
			j++;
		}
	}

	return out;
}
