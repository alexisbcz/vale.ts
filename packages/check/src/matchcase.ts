/**
 * Adapting replacement text to the case of what it replaces.
 *
 * A rule's replacement is written one way -- `A-OK` -- but the text it
 * corrects may be lower case, capitalized or shouted. Substituting the literal
 * leaves `I am A-OK with the plan`, so a rule that means "spell this phrase
 * correctly" has to carry the case of what it found.
 *
 * Only uniform casing is inferred. Text that mixes cases in its own way
 * (`iPhone`, `McDonald`) is left alone, because there is no rule to read off
 * it and guessing would corrupt a deliberate spelling.
 */

import { capFirst } from "@vale-ts/core";

/** The three patterns that can be reproduced in a different string. */
enum Casing {
	None = 0,
	Lower = 1,
	Upper = 2,
	Title = 3,
}

/** Adapts `replacement` to the case of `observed`. */
export function matchCase(replacement: string, observed: string): string {
	// Case varies across a phrase -- `BLU ray` is shouted then not, `Cross
	// Platform` capitalizes both halves -- so it is read word by word.
	const wordwise = matchWordwise(replacement, observed);
	if (wordwise !== null) return wordwise;

	switch (caseOf(observed)) {
		case Casing.Lower:
			return replacement.toLowerCase();
		case Casing.Upper:
			return replacement.toUpperCase();
		case Casing.Title:
			return capFirst(replacement.toLowerCase());
		default:
			return replacement;
	}
}

/**
 * Re-cases the replacement word by word, from the text it replaces, or returns
 * null when there is nothing to align.
 *
 * The two rarely have the same length -- `to backout` becomes `to back out`,
 * and `look in to when` becomes `look into when` -- but the words a rule
 * leaves alone sit at the edges unchanged. Aligning those, and treating what
 * is left in the middle as one block, carries the case across without needing
 * to know which words the rule meant to rewrite.
 *
 * Separators come from the replacement, so `blu-ray` stays hyphenated even
 * though the `BLU ray` it corrects is not.
 */
function matchWordwise(replacement: string, observed: string): string | null {
	const [rw, seps] = words(replacement);
	const [ow] = words(observed);

	if (rw.length === 0 || ow.length === 0) return null;

	// Words identical on both sides are ones the rule kept; they anchor the
	// alignment.
	let head = 0;
	while (head < rw.length && head < ow.length && equalFold(rw[head]!, ow[head]!)) {
		head++;
	}

	let tail = 0;
	while (
		tail < rw.length - head &&
		tail < ow.length - head &&
		equalFold(rw[rw.length - 1 - tail]!, ow[ow.length - 1 - tail]!)
	) {
		tail++;
	}

	// What is left in the middle is the rewrite itself. Its case comes from
	// the whole of the middle it replaces, since the words do not correspond.
	const midWords = ow.slice(head, ow.length - tail);
	let mid = caseOf(midWords.join(" "));

	// A rule can insert a word rather than change one -- `there an` becoming
	// `there is an` -- leaving no text to read the case from. The word it is
	// inserted before answers for it: `THERE AN` gives `THERE IS AN`, while
	// `Some the` gives `Some of the`. The following word is the one to ask,
	// because a capital on the preceding word may only mean the sentence
	// started there.
	if (midWords.length === 0) {
		if (tail > 0) mid = caseOf(ow[ow.length - tail]!);
		else if (head > 0) mid = caseOf(ow[head - 1]!);
	}

	// Title case describes a phrase, not each word in it: `Bad rep` becoming
	// `poor showing` gives `Poor showing`, not `Poor Showing`. Only when every
	// word it replaces is capitalized does each word get a capital.
	let midFirst = true;
	const perWord = mid === Casing.Title && allTitle(midWords.join(" "));

	let out = "";
	for (let i = 0; i < rw.length; i++) {
		const w = rw[i]!;
		out += seps[i] ?? "";

		let c = mid;
		if (i < head) c = caseOf(ow[i]!);
		else if (i >= rw.length - tail) c = caseOf(ow[ow.length - (rw.length - i)]!);

		const inMid = i >= head && i < rw.length - tail;
		if (c === Casing.Title && inMid && !perWord && !midFirst) c = Casing.Lower;
		if (inMid) midFirst = false;

		switch (c) {
			case Casing.Lower:
				out += w.toLowerCase();
				break;
			case Casing.Upper:
				out += w.toUpperCase();
				break;
			case Casing.Title:
				out += capFirst(w.toLowerCase());
				break;
			default:
				out += w;
		}
	}
	out += seps[rw.length] ?? "";

	return out;
}

function equalFold(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

function isLetter(c: string): boolean {
	return /\p{L}/u.test(c);
}

/** Whether the character at `i` of `chars` sits between two letters. */
function inWord(chars: readonly string[], i: number): boolean {
	return (
		i > 0 &&
		i + 1 < chars.length &&
		isLetter(chars[i - 1]!) &&
		isLetter(chars[i + 1]!)
	);
}

function isApostrophe(c: string): boolean {
	return c === "'" || c === "’";
}

/**
 * Splits `s` into runs of letters and the separators around them.
 *
 * The separators come back with one more entry than the words, so the string
 * rebuilds as `sep[0] + word[0] + sep[1] + ... + sep[words.length]`.
 */
export function words(s: string): [string[], string[]] {
	const out: string[] = [];
	const seps: string[] = [];
	let cur = "";
	let sep = "";

	const chars = [...s];
	for (let i = 0; i < chars.length; i++) {
		const r = chars[i]!;
		// An apostrophe inside a word belongs to it: splitting `you're` into
		// `you` and `re` makes it two words, and a two-word phrase it replaces
		// then fails to line up.
		if (isLetter(r) || (isApostrophe(r) && inWord(chars, i))) {
			if (sep.length > 0 || cur.length === 0) {
				seps.push(sep);
				sep = "";
			}
			cur += r;
			continue;
		}
		if (cur.length > 0) {
			out.push(cur);
			cur = "";
		}
		sep += r;
	}

	if (cur.length > 0) out.push(cur);
	seps.push(sep);

	return [out, seps];
}

/** Classifies text by the only three patterns that can be reproduced. */
function caseOf(s: string): Casing {
	let letters = 0;
	let upper = 0;
	let lower = 0;
	let firstUpper = false;
	let seenLetter = false;

	for (const r of s) {
		if (!isLetter(r)) continue;
		letters++;
		if (/\p{Lu}/u.test(r)) {
			upper++;
			if (!seenLetter) firstUpper = true;
		} else if (/\p{Ll}/u.test(r)) {
			lower++;
		}
		seenLetter = true;
	}

	if (letters === 0) return Casing.None;
	if (upper === 0) return Casing.Lower;
	if (lower === 0) {
		// A single capital is a capitalized word, not a shouted one; treating
		// "A" as upper case would shout every replacement it stands in for.
		return letters === 1 ? Casing.Title : Casing.Upper;
	}
	if (firstUpper && upper === 1) return Casing.Title;

	return Casing.None;
}

/**
 * Whether every word in `s` is capitalized, as a heading or a proper name
 * would be.
 *
 * `caseOf` sees only one string and cannot tell `Cross Platform` from
 * `McDonald`.
 */
function allTitle(s: string): boolean {
	const [w] = words(s);
	if (w.length < 2) return false;
	for (const x of w) {
		if (caseOf(x) !== Casing.Title) return false;
	}
	return true;
}

/** Applies `matchCase` to every suggestion a rule offers. */
export function recase(params: readonly string[], observed: string): string[] {
	return params.map((p) => matchCase(p, observed));
}
