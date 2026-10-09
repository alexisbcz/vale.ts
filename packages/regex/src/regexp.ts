/**
 * The compiled-pattern type the rest of the port uses.
 *
 * It mirrors the surface `internal/regex` gives Vale -- `FindAllStringIndex`,
 * `FindAllStringSubmatchIndex`, `Replace`, `Split`, `MightMatch` -- so that a
 * ported check reads the way the Go one does.
 *
 * # Offsets
 *
 * Go reports rune offsets here and byte offsets elsewhere, and converts between
 * the two. This port has one unit: the JavaScript string index, which is a
 * UTF-16 code unit. Every offset a check sees, stores or slices with is in that
 * unit, so no conversion is needed anywhere. Columns are the exception -- a
 * column is a count of characters, which `strLen` provides.
 */

import { Required } from "./prefilter.ts";
import type { Translation } from "./translate.ts";
import { syntheticName, translate } from "./translate.ts";

/** One match, with the spans of its capture groups. */
export interface RegexpMatch {
	/** The matched text. */
	text: string;
	/** Where the match begins. */
	index: number;
	/** Where it ends, exclusive. */
	end: number;
	/**
	 * `[begin, end]` per group in .NET's numbering, index 0 being the whole
	 * match. A group that did not take part is `[-1, -1]`.
	 */
	spans: Array<[number, number]>;
	/** The text of each group, or undefined where it did not take part. */
	groups: Array<string | undefined>;
}

export class Regexp {
	/** The pattern as written. */
	readonly pattern: string;
	/** The literals a subject must contain one of; see `prefilter.ts`. */
	readonly filter: readonly string[];

	private readonly t: Translation;
	private readonly re: RegExp;
	/** The same expression anchored at the start, for `matchesWhole`. */
	private anchored: RegExp | null = null;

	private constructor(t: Translation, filter: string[]) {
		this.t = t;
		this.pattern = t.pattern;
		this.filter = filter;
		this.re = new RegExp(t.source, t.flags);
	}

	/** Compiles a pattern, throwing `PatternError` if it cannot be read. */
	static compile(pattern: string): Regexp {
		const t = translate(pattern);
		return new Regexp(t, Required(pattern));
	}

	/** Compiles a pattern that is fixed at build time. */
	static mustCompile(pattern: string): Regexp {
		return Regexp.compile(pattern);
	}

	/** The body `RegExp` was given, for debugging. */
	get jsSource(): string {
		return this.t.source;
	}

	/** The flags `RegExp` was given. */
	get jsFlags(): string {
		return this.t.flags;
	}

	/** How many capturing groups the pattern has. */
	get captureCount(): number {
		return this.t.captureCount;
	}

	toString(): string {
		return this.pattern;
	}

	/**
	 * Reports whether `lowered` could hold a match.
	 *
	 * `lowered` is the subject lower-cased, which a caller does once per block
	 * rather than once per rule. A false answer is definitive; a true one means
	 * the pattern still has to run.
	 */
	mightMatch(lowered: string): boolean {
		if (this.filter.length === 0) return true;
		for (const lit of this.filter) {
			if (lowered.includes(lit)) return true;
		}
		return false;
	}

	/** Reports whether `s` holds a match. */
	test(s: string): boolean {
		this.re.lastIndex = 0;
		return this.re.test(s);
	}

	/** The group names by capture number; index 0 is "". */
	subexpNames(): string[] {
		return this.t.groupNames.slice();
	}

	/** The first match in `s`, or null. */
	find(s: string): RegexpMatch | null {
		for (const m of this.matches(s, 1)) return m;
		return null;
	}

	/**
	 * Walks up to `n` successive matches, or all of them when `n < 0`.
	 *
	 * Matching is driven by hand rather than through `String.matchAll` so that
	 * a zero-length match advances by one character, as the Go engine does,
	 * instead of looping.
	 */
	*matches(s: string, n = -1): Generator<RegexpMatch> {
		if (n === 0) return;
		this.re.lastIndex = 0;
		let count = 0;
		let at = 0;

		while (at <= s.length) {
			this.re.lastIndex = at;
			const m = this.re.exec(s);
			if (m === null) return;

			const indices = m.indices;
			const begin = m.index;
			const end = begin + m[0]!.length;

			const spans: Array<[number, number]> = [[begin, end]];
			const groups: Array<string | undefined> = [m[0]];
			for (let g = 1; g <= this.t.captureCount; g++) {
				const name = syntheticName(g);
				const span = indices?.groups?.[name];
				if (span === undefined) {
					spans.push([-1, -1]);
					groups.push(undefined);
				} else {
					spans.push([span[0], span[1]]);
					groups.push(s.slice(span[0], span[1]));
				}
			}

			yield { text: m[0]!, index: begin, end, spans, groups };

			count++;
			if (n > 0 && count >= n) return;
			at = end > begin ? end : begin + charWidthAt(s, begin);
		}
	}

	/** The text of up to `n` matches. */
	findAllString(s: string, n = -1): string[] {
		const out: string[] = [];
		for (const m of this.matches(s, n)) out.push(m.text);
		return out;
	}

	/** The `[begin, end]` bounds of up to `n` matches. */
	findAllStringIndex(s: string, n = -1): Array<[number, number]> {
		const out: Array<[number, number]> = [];
		for (const m of this.matches(s, n)) out.push([m.index, m.end]);
		return out;
	}

	/**
	 * Up to `n` matches as flat `[begin, end, ...]` arrays, one pair per group.
	 *
	 * The shape Go's `FindAllStringSubmatchIndex` returns, which several checks
	 * index into directly.
	 */
	findAllStringSubmatchIndex(s: string, n = -1): number[][] {
		const out: number[][] = [];
		for (const m of this.matches(s, n)) {
			const flat: number[] = [];
			for (const [lo, hi] of m.spans) flat.push(lo, hi);
			out.push(flat);
		}
		return out;
	}

	/** Up to `n` matches as their group texts, `""` for a group that missed. */
	findAllStringSubmatch(s: string, n = -1): string[][] {
		const out: string[][] = [];
		for (const m of this.matches(s, n)) {
			out.push(m.groups.map((g) => g ?? ""));
		}
		return out;
	}

	/** Every match in `s`. */
	findAllMatches(s: string): RegexpMatch[] {
		return [...this.matches(s, -1)];
	}

	/**
	 * Reports whether `s` is wholly matched, which is how a rule asks whether a
	 * word is one of its exceptions.
	 */
	matchesWhole(s: string): boolean {
		if (this.anchored === null) {
			const flags = this.t.flags.replace("g", "");
			this.anchored = new RegExp(`^(?:${this.t.source})$`, flags);
		}
		return this.anchored.test(s);
	}

	/**
	 * Slices `s` around each match, returning at most `n` pieces.
	 *
	 * `n < 0` means no limit; a pattern that never matches gives back `s` whole.
	 */
	split(s: string, n = -1): string[] {
		if (n === 0) return [s];
		const out: string[] = [];
		let last = 0;
		for (const m of this.matches(s, -1)) {
			if (n > 0 && out.length === n - 1) break;
			out.push(s.slice(last, m.index));
			last = m.end;
		}
		out.push(s.slice(last));
		return out;
	}

	/**
	 * Replaces up to `count` matches with `replacement`, starting at `startAt`.
	 *
	 * `count < 0` means every match, and `startAt < 0` means from the
	 * beginning -- the convention `regexp2.Replace` uses, which the callers
	 * ported from Vale pass through.
	 *
	 * The replacement understands `$1`, `${1}`, `${name}` and `$$`. Note that
	 * `$<name>` is JavaScript's spelling, not .NET's, and is left alone.
	 */
	replace(s: string, replacement: string, startAt = -1, count = -1): string {
		return this.replaceFunc(
			s,
			(m) => expand(replacement, m, this.t),
			startAt,
			count,
		);
	}

	/** `replace`, with a function deciding each replacement. */
	replaceFunc(
		s: string,
		fn: (m: RegexpMatch) => string,
		startAt = -1,
		count = -1,
	): string {
		if (count === 0) return s;
		const from = startAt < 0 ? 0 : startAt;
		let out = s.slice(0, from);
		let last = from;
		let done = 0;

		for (const m of this.matches(s.slice(from), -1)) {
			const begin = from + m.index;
			const end = from + m.end;
			const shifted: RegexpMatch = {
				text: m.text,
				index: begin,
				end,
				spans: m.spans.map(([lo, hi]) =>
					lo < 0 ? [-1, -1] : [lo + from, hi + from],
				),
				groups: m.groups,
			};
			out += s.slice(last, begin) + fn(shifted);
			last = end;
			done++;
			if (count > 0 && done >= count) break;
		}

		return out + s.slice(last);
	}
}

/** How many code units the character at `i` occupies. */
function charWidthAt(s: string, i: number): number {
	const cp = s.codePointAt(i);
	return cp !== undefined && cp > 0xffff ? 2 : 1;
}

/** Expands `$`-references in a replacement string. */
function expand(repl: string, m: RegexpMatch, t: Translation): string {
	let out = "";
	for (let i = 0; i < repl.length; i++) {
		const c = repl[i]!;
		if (c !== "$") {
			out += c;
			continue;
		}
		const next = repl[i + 1];
		if (next === "$") {
			out += "$";
			i++;
			continue;
		}
		if (next === "{") {
			const close = repl.indexOf("}", i + 2);
			if (close < 0) {
				out += c;
				continue;
			}
			const ref = repl.slice(i + 2, close);
			out += groupText(ref, m, t);
			i = close;
			continue;
		}
		if (next !== undefined && next >= "0" && next <= "9") {
			let digits = "";
			let j = i + 1;
			while (j < repl.length && repl[j]! >= "0" && repl[j]! <= "9") {
				// .NET stops as soon as adding another digit would name a group
				// the pattern does not have.
				const candidate = digits + repl[j]!;
				if (Number.parseInt(candidate, 10) > t.captureCount) break;
				digits = candidate;
				j++;
			}
			if (digits === "") {
				out += c;
				continue;
			}
			out += groupText(digits, m, t);
			i = j - 1;
			continue;
		}
		out += c;
	}
	return out;
}

function groupText(ref: string, m: RegexpMatch, t: Translation): string {
	const asNumber = Number.parseInt(ref, 10);
	const n = Number.isNaN(asNumber) ? t.nameToNumber.get(ref) : asNumber;
	if (n === undefined || n < 0 || n >= m.groups.length) return "";
	return m.groups[n] ?? "";
}
