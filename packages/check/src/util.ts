/**
 * The slice helpers Go's `core` package provides and this port's `core` does
 * not, kept here so the ported checks read as they do in Go.
 */

export function stringInSlice(a: string, slice: readonly string[]): boolean {
	return slice.includes(a);
}

/** Whether every member of `needles` appears in `haystack`. */
export function allStringsInSlice(
	needles: readonly string[],
	haystack: readonly string[],
): boolean {
	for (const n of needles) {
		if (!haystack.includes(n)) return false;
	}
	return true;
}

export function intInSlice(a: number, slice: readonly number[]): boolean {
	return slice.includes(a);
}

/** Go's `strings.Fields`: the whitespace-separated runs of `s`. */
export function fields(s: string): string[] {
	return s.split(/\s+/u).filter((f) => f !== "");
}

/** Go's `strings.Trim`: drops any leading or trailing character in `cutset`. */
export function trimCutset(s: string, cutset: string): string {
	return trimRightCutset(trimLeftCutset(s, cutset), cutset);
}

export function trimLeftCutset(s: string, cutset: string): string {
	let i = 0;
	while (i < s.length && cutset.includes(s[i]!)) i++;
	return s.slice(i);
}

export function trimRightCutset(s: string, cutset: string): string {
	let i = s.length;
	while (i > 0 && cutset.includes(s[i - 1]!)) i--;
	return s.slice(0, i);
}

/**
 * Go's `strings.Title`, which capitalizes the first letter of every word.
 *
 * Deprecated in Go for being wrong about language-specific casing, and still
 * what `check.sentence` compares its first token against -- so the comparison
 * has to be made the same way, including its treatment of an apostrophe as a
 * word boundary (`isn't` becomes `Isn'T`).
 */
export function goStringsTitle(s: string): string {
	let out = "";
	let prevIsSeparator = true;
	for (const r of s) {
		if (prevIsSeparator && /\p{L}/u.test(r)) out += r.toUpperCase();
		else out += r;
		prevIsSeparator = isSeparator(r);
	}
	return out;
}

/** Go's `strings.isSeparator`. */
function isSeparator(r: string): boolean {
	const code = r.codePointAt(0) ?? 0;
	if (code <= 0x7f) {
		if ((code >= 0x30 && code <= 0x39) || code === 0x5f) return false;
		if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
			return false;
		}
		return true;
	}
	if (/\p{L}/u.test(r)) return false;
	return /\s/u.test(r);
}

/** The FNV-1a 32-bit hash of `s`, as eight lower-case hexadecimal digits. */
export function fnv32a(s: string): string {
	let h = 0x811c9dc5;
	// Hashed over the UTF-8 bytes, as Go's `hash/fnv` is handed them, so a
	// selector naming a non-ASCII class gets the same id in both.
	for (const b of new TextEncoder().encode(s)) {
		h ^= b;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** Go's `strings.HasSuffix` over a list of suffixes. */
export function hasAnySuffix(s: string, suffixes: readonly string[]): boolean {
	for (const suffix of suffixes) {
		if (s.endsWith(suffix)) return true;
	}
	return false;
}
