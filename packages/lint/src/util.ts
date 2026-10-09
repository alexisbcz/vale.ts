/**
 * Placing a value's alerts back in the file it came from.
 *
 * A value read out of structured data -- a YAML description, a commit message's
 * body -- is linted on its own, so its alerts carry positions within the value
 * rather than within the file. These helpers move them: by the position the
 * parser reported where there is one, and by searching for the text where there
 * is not.
 */

import type { Alert } from "@vale-ts/core";

/**
 * The line of `s` that best matches `sub`, by edit distance among the lines
 * that contain it.
 *
 * Used for TOML front matter, which carries no positions: several lines may
 * hold the value, and the closest one is the one it came from.
 */
export function findBestLineBySubstring(
	s: string,
	subArg: string,
): [number, string] {
	let sub = subArg;
	if (sub.includes("\n")) sub = sub.split("\n")[0]!;

	let bestLine = -1;
	let best = "";
	let bestDistance = -1;

	const lines = s.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.includes(sub)) continue;
		const distance = similarity(line, sub);
		if (bestLine === -1 || distance < bestDistance) {
			bestDistance = distance;
			bestLine = i;
			best = line;
		}
	}

	return [bestLine, best];
}

/**
 * The first line of `s` holding `sub` that has not already been used.
 *
 * `seen` records which line each text was found on, so two fields with the same
 * value do not both land on the first.
 */
export function findLineBySubstring(
	s: string,
	subArg: string,
	seen: Map<string, number>,
): [number, string] {
	let sub = subArg;
	const breaks = countNewlines(sub);
	if (breaks > 0) {
		const parts = sub.split("\n");
		sub = parts[0]!;
		if (parts.length > 1 && parts[1] !== "") sub = parts[1]!;
	}

	const lines = s.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.includes(sub)) continue;
		const j = seen.get(line);
		if (j === undefined || j - 1 !== i) return [i + 1, line];
	}

	if (breaks <= 0) {
		// A value the conversion rewrote is not on any line whole; one of its
		// words usually is.
		for (const part of sub.split(" ")) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (!line.includes(part)) continue;
				const j = seen.get(line);
				if (j === undefined || j - 1 !== i) return [i + 1, line];
			}
		}
	}

	return [-1, ""];
}

/**
 * Shifts the alerts from `last` on by the position the value sits at.
 *
 * A value written as a quoted scalar with an escaped newline occupies one
 * source line, so an alert past that newline needs its column widened by the
 * breaks before it.
 */
export function adjustPos(
	alerts: Alert[],
	last: number,
	line: number,
	padding: number,
	value: string,
	rawLine: string,
): Alert[] {
	for (let i = last; i < alerts.length; i++) {
		const a = alerts[i]!;
		a.line += line - 1;
		let extra = 0;
		if (countNewlines(value) > 0 && rawLine.includes("\\n")) {
			const pos = a.span[0]! - 1;
			extra = countNewlines(value.slice(0, pos));
		}
		a.span = [a.span[0]! + padding + extra, a.span[1]! + padding + extra];
	}
	return alerts;
}

/**
 * Normalized Levenshtein similarity, as `adrg/strutil` computes it: 1 for
 * identical strings, 0 for nothing in common.
 */
export function similarity(a: string, b: string): number {
	const longest = Math.max([...a].length, [...b].length);
	if (longest === 0) return 1;
	return 1 - distance(a, b) / longest;
}

/** The Levenshtein edit distance between two strings, counting characters. */
export function distance(a: string, b: string): number {
	const x = [...a];
	const y = [...b];
	if (x.length === 0) return y.length;
	if (y.length === 0) return x.length;

	let prev = new Array<number>(y.length + 1);
	let curr = new Array<number>(y.length + 1);
	for (let j = 0; j <= y.length; j++) prev[j] = j;

	for (let i = 1; i <= x.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= y.length; j++) {
			const cost = x[i - 1] === y[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
		}
		[prev, curr] = [curr, prev];
	}

	return prev[y.length]!;
}

export function countNewlines(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\n") n++;
	}
	return n;
}

/** The text of line `line` of `s`, 1-based, or "". */
export function findLine(s: string, line: number): string {
	const lines = s.split("\n");
	if (line > lines.length || line < 1) return "";
	return lines[line - 1]!;
}

/** How many spaces a line begins with, less `offset`. */
export function leadingSpaces(line: string, offset: number): number {
	let spaces = 0;
	for (const r of line) {
		if (r === " ") spaces++;
		else break;
	}
	return spaces - offset;
}
