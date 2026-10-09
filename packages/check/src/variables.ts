/**
 * The `match` values a `capitalization` rule can name, and the scoring that
 * decides whether a block already conforms.
 *
 * `$title` and `$sentence` are judged against the whole re-cased string rather
 * than word by word, because a converter may move a word's case for a reason a
 * single word cannot show -- the `to` of an infinitive, say. Scoring the words
 * that agree and comparing against a threshold is what keeps a heading with
 * one proper noun in it from being reported.
 */

import { Regexp } from "@vale-ts/regex";
import { isMatch } from "./definition.ts";
import type { IndicatorFunc, SentenceConverter, TitleConverter } from "./strcase.ts";
import { goStringsTitle, hasAnySuffix } from "./util.ts";

const RE_NUMBER_LIST = Regexp.mustCompile(String.raw`\d+\.`);

/**
 * The pattern the capitalization checks split words with.
 *
 * It depends only on the rule's exceptions, which are fixed when the rule
 * loads, but it was built and compiled on every call -- once per check per
 * block. Compiling a pattern is not cheap, and this one was recompiled
 * hundreds of times over a single document.
 */
const tokenPattern = new Map<string, Regexp>();

export function wordsIn(except: Regexp | null): Regexp {
	let ps = String.raw`[\p{N}\p{L}*]+[^\s]*`;
	if (except !== null && except.pattern !== "") {
		ps = `${except.pattern}|${ps}`;
	}

	const hit = tokenPattern.get(ps);
	if (hit !== undefined) return hit;

	const re = Regexp.mustCompile(ps);
	tokenPattern.set(ps, re);
	return re;
}

/** What `match` returns: the expected spelling, and whether the text conforms. */
export type CheckFunc = (s: string, except: Regexp | null) => [string, boolean];

/** The readability metrics a `readability` rule can name. */
export const READABILITY_METRICS = [
	"Gunning Fog",
	"Coleman-Liau",
	"Flesch-Kincaid",
	"SMOG",
	"Automated Readability",
];

/** A rule's `indicators`, as the sentence converter asks the question. */
export function wasIndicator(indicators: readonly string[]): IndicatorFunc {
	return (word, idx) => {
		if (hasAnySuffix(word, indicators)) return true;
		return idx === 0 && RE_NUMBER_LIST.test(word);
	};
}

export function lower(s: string, re: Regexp | null): [string, boolean] {
	const expected = s.toLowerCase();
	return [expected, s === expected || isMatch(re, s)];
}

export function upper(s: string, re: Regexp | null): [string, boolean] {
	const expected = s.toUpperCase();
	return [expected, s === expected || isMatch(re, s)];
}

export const VAR_TO_FUNC: Record<string, CheckFunc> = {
	$lower: lower,
	$upper: upper,
};

/** Scores a string against its title-cased form. */
export function title(
	s: string,
	except: Regexp | null,
	tc: TitleConverter,
	threshold: number,
): [string, boolean] {
	let count = 0;
	let words = 0;

	const re = wordsIn(except);

	const expected = tc.convert(s);
	const expectedTokens = re.findAllString(expected, -1);

	const extent = expectedTokens.length;
	const found = re.findAllString(s, -1);
	for (let i = 0; i < found.length; i++) {
		const word = found[i]!;
		if (i >= extent) {
			// The converter splits words with a pattern of its own, which is
			// not the one the exceptions are built into, so the two token
			// lists can run to different lengths. That only happens when the
			// entry at `expected[i]` is an exception, so it counts as agreeing.
			count++;
		} else if (word === expectedTokens[i] || isMatch(except, word)) {
			count++;
		} else if (word === word.toUpperCase()) {
			count++;
		}
		words++;
	}

	return [expected, count / words >= threshold];
}

/** Scores a string against its sentence-cased form. */
export function sentence(
	s: string,
	except: Regexp | null,
	sc: SentenceConverter,
	threshold: number,
): [string, boolean] {
	let count = 0;
	let words = 0;

	const re = wordsIn(except);

	const expected = sc.convert(s);
	const expectedTokens = re.findAllString(expected, -1);

	const extent = expectedTokens.length;
	const found = re.findAllString(s, -1);
	for (let i = 0; i < found.length; i++) {
		const w = found[i]!;
		if (i >= extent) {
			count++;
		} else if (w === expectedTokens[i] || isMatch(except, w)) {
			count++;
		} else if (i === 0 && w !== goStringsTitle(w.toLowerCase())) {
			// A first word that is not capitalized at all is not sentence case,
			// whatever the rest of the string scores.
			return [expected, false];
		}
		words++;
	}

	return [expected, count / words >= threshold];
}
