/**
 * Case conversion, ported from `prose/v3/strcase`.
 *
 * Two kinds live here. The word-level converters -- kebab, snake, camel,
 * pascal, simple -- are mechanical: they re-join the pieces of an identifier
 * with a separator. Title and sentence case are not, because English decides
 * them by part of speech: AP style capitalizes `to` in an infinitive and
 * leaves it alone in a prepositional phrase, which cannot be told apart
 * without tagging the words.
 *
 * Only the parts Vale reaches for are here. `Dot` and `Constant` are prose's
 * and nothing in Vale calls them.
 */

import { strLen } from "@vale-ts/core";
import { newTagger, type Token, TreebankWordTokenizer } from "@vale-ts/nlp";
import { Regexp } from "@vale-ts/regex";

/** Decides whether a word should be capitalized, given the tagged sentence. */
export type IgnoreFunc = (
	word: string,
	tags: readonly Token[],
	idx: number,
	firstOrLast: boolean,
) => boolean;

/** Decides whether the word after `word` starts a new sentence. */
export type IndicatorFunc = (word: string, idx: number) => boolean;

/** What both converters read. */
export interface CaseOpts {
	/**
	 * A pattern for a prefix to hold back before converting, as in the `a. `
	 * of a lettered list.
	 */
	prefix: string;
	/** Terms to spell as written, each a literal or a pattern. */
	vocab: string[];
	/** Whether the word after this one begins a sentence. */
	indicator: IndicatorFunc;
}

/** The whitespace a vocabulary term holds, for sorting it longest first. */
function byLengthDesc(a: string, b: string): number {
	return b.length - a.length;
}

/**
 * The vocabulary, longest term first.
 *
 * The terms go into one alternation, and a regular-expression alternation is
 * first-match rather than longest-match: with `Axon` ahead of `Axon Server`,
 * the longer term could never match.
 */
export function usingVocab(vocab: readonly string[]): string[] {
	return [...vocab].sort(byLengthDesc);
}

const RE_NUMBER_LIST = /\d+\./;

/** The default: a colon, or a leading list number, starts a new sentence. */
export const defaultIndicator: IndicatorFunc = (word, idx) => {
	if (word.endsWith(":")) return true;
	return idx === 0 && RE_NUMBER_LIST.test(word);
};

/** No word is left lower-cased by default. */
const neverIndicator: IndicatorFunc = () => false;

function newOpts(partial: Partial<CaseOpts>, indicator: IndicatorFunc): CaseOpts {
	return {
		prefix: partial.prefix ?? "",
		vocab: partial.vocab === undefined ? [] : usingVocab(partial.vocab),
		indicator: partial.indicator ?? indicator,
	};
}

/** The pattern a converter splits words with, built from its vocabulary. */
function wordPattern(vocab: readonly string[]): string {
	const ps = String.raw`[\p{N}\p{L}*]+[^\s]*`;
	if (vocab.length === 0) return ps;
	return String.raw`\b(?:${vocab.join("|")})\b|${ps}`;
}

/**
 * Whether `s` is a vocabulary term, and how to spell it.
 *
 * A term written as plain text supplies its own spelling; a term written as a
 * pattern cannot, so the text is kept as the author wrote it.
 */
function inVocab(vocab: readonly string[], s: string): string {
	for (const token of vocab) {
		if (token.toLowerCase() === s.toLowerCase()) return token;
		let matched = false;
		try {
			matched = Regexp.compile(token).test(s);
		} catch {
			// An unparsable entry matches nothing, as prose's wrapper has it:
			// one bad vocabulary term must not stop a conversion.
			matched = false;
		}
		if (matched) return s;
	}
	return "";
}

/** Uppercases the first character; `strict` lowercases the rest. */
export function toTitle(m: string, strict: boolean): string {
	if (m === "") return m;
	const first = String.fromCodePoint(m.codePointAt(0)!);
	const rest = m.slice(first.length);
	return first.toUpperCase() + (strict ? rest.toLowerCase() : rest);
}

/** Holds back a prefix the converter must not touch. */
function splitPrefix(s: string, prefix: string): [string, string] {
	if (prefix === "") return ["", s];
	let re: Regexp;
	try {
		re = Regexp.compile(prefix);
	} catch {
		return ["", s];
	}
	const found = re.findAllString(s, 1);
	const first = found[0];
	if (first === undefined || !s.startsWith(first)) return ["", s];
	return [first, s.slice(first.length)];
}

/** Converts a string to sentence case. */
export class SentenceConverter {
	private readonly opts: CaseOpts;

	constructor(partial: Partial<CaseOpts> = {}) {
		this.opts = newOpts(partial, defaultIndicator);
	}

	convert(input: string): string {
		const [prefix, s] = splitPrefix(input, this.opts.prefix);

		// Tokenized before anything is lowered, so a vocabulary entry keeps
		// the case it was written with.
		const re = Regexp.compile(`(?i)${wordPattern(this.opts.vocab)}`);
		const tokens = re.findAllString(s, -1);

		const made: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			const prev = i - 1 >= 0 ? tokens[i - 1]! : "";

			const entry = inVocab(this.opts.vocab, token);
			if (entry !== "") made.push(entry);
			else if (i === 0 || this.opts.indicator(prev, i - 1)) {
				made.push(toTitle(token, true));
			} else made.push(token.toLowerCase());
		}

		return prefix + made.join(" ");
	}
}

/** The words AP style leaves lower-cased. */
const SMALL_WORDS = [
	"a",
	"an",
	"and",
	"as",
	"at",
	"but",
	"by",
	"en",
	"for",
	"if",
	"in",
	"nor",
	"of",
	"on",
	"or",
	"per",
	"the",
	"to",
	"vs",
	"vs.",
	"via",
	"v",
	"v.",
];

/** The prepositions Chicago style leaves lower-cased, whatever their length. */
const PREPOSITIONS = [
	"with",
	"from",
	"into",
	"during",
	"including",
	"until",
	"against",
	"among",
	"throughout",
	"despite",
	"towards",
	"upon",
	"concerning",
	"about",
	"over",
	"through",
	"before",
	"between",
	"after",
	"since",
	"without",
	"under",
	"within",
	"along",
	"following",
	"across",
	"beyond",
	"around",
	"down",
	"near",
	"above",
];

/**
 * AP style: capitalize the first and last word, capitalize `to` in an
 * infinitive, and leave the short articles, conjunctions and prepositions
 * alone.
 */
export const apStyle: IgnoreFunc = (word, tags, idx, bounding) => {
	if (word === "to" && idx + 1 < tags.length) {
		return tags[idx + 1]!.tag.startsWith("NN");
	}
	return !bounding && SMALL_WORDS.includes(word);
};

/**
 * Chicago style: lowercase articles, coordinating conjunctions and
 * prepositions regardless of length, unless first or last.
 */
export const chicagoStyle: IgnoreFunc = (word, _tags, _idx, bounding) => {
	return !bounding && (SMALL_WORDS.includes(word) || PREPOSITIONS.includes(word));
};

/** The characters the tagger is better off not seeing. */
const SANITIZE: ReadonlyArray<readonly [string, string]> = [
	["“", '"'],
	["”", '"'],
	["‘", "'"],
	["’", "'"],
	["–", "-"],
	["—", "-"],
	["…", "..."],
];

function sanitizeForTagging(s: string): string {
	let out = s;
	for (const [from, to] of SANITIZE) out = out.replaceAll(from, to);
	return out;
}

const SPLIT_RE = /[\p{N}\p{L}]+[^\s\-/]*/gu;

let tokenizer: TreebankWordTokenizer | null = null;
let tagger: ReturnType<typeof newTagger> | null = null;

/**
 * The tokenizer and tagger, built on first use.
 *
 * The part-of-speech model is a few megabytes to decode, and a run that only
 * ever converts to kebab case should not pay for it.
 */
function taggedWords(s: string): Token[] {
	if (tokenizer === null) tokenizer = new TreebankWordTokenizer();
	if (tagger === null) tagger = newTagger();

	// The tagger is sensitive to trailing punctuation, so a title without any
	// is given a period it never sees again.
	const forTagging = /[.!?]$/.test(s) ? s : `${s}.`;
	return tagger.tag(tokenizer.tokenize(forTagging));
}

/** The character at `i`, or `""` when that is outside `s`. */
function charAt(s: string, i: number): string {
	return i >= 0 && i < s.length ? s[i]! : "";
}

/** Converts a string to title case, by a style. */
export class TitleConverter {
	private readonly opts: CaseOpts;
	private readonly ignore: IgnoreFunc;

	constructor(style: IgnoreFunc, partial: Partial<CaseOpts> = {}) {
		this.ignore = style;
		this.opts = newOpts(partial, neverIndicator);
	}

	convert(input: string): string {
		const [prefix, s] = splitPrefix(input, this.opts.prefix);

		const t = sanitizeForTagging(s);
		const end = t.length;
		const tags = taggedWords(s);

		let idx = 0;
		let widx = -1;

		const body = s.replace(SPLIT_RE, (m) => {
			widx++;

			const sm = m.toLowerCase();
			// Walked rather than searched from the start, so a word that
			// occurs twice is judged at the occurrence being replaced.
			const at = t.indexOf(m, idx);
			const start = at < 0 ? idx : at;
			const prev = charAt(t, start - 1);
			const ext = m.length;

			idx = start + ext;

			const found = inVocab(this.opts.vocab, m);
			if (found !== "") return found;

			// A word the style leaves alone is only left alone where it really
			// is a separate word: preceded by a space, a hyphen or a slash,
			// not sitting after a colon or inside a hyphenated compound.
			if (
				this.ignore(sm, tags, widx, start === 0 || idx === end) &&
				(prev === " " || prev === "-" || prev === "/") &&
				charAt(t, start - 2) !== ":" &&
				charAt(t, start - 2) !== "-" &&
				(charAt(t, start + ext) !== "-" || charAt(t, start - 1) === "-")
			) {
				return sm;
			}

			return toTitle(m, false);
		});

		return prefix + body;
	}
}

const SPACES = / +/g;

/**
 * Splits `s` into words and re-joins them with `sep`, mapping each character
 * through `t`.
 *
 * A change from lower case to upper starts a new word, which is what takes
 * `FooBar` apart; anything that is not a letter or a number is a separator.
 */
function removeCase(s: string, sep: string, t: (c: string) => string): string {
	let out = "";
	let old = " ";
	let i = 0;
	for (const c of s) {
		const alpha = /[\p{L}\p{N}]/u.test(c);
		const boundary = i > 1 && /\p{Ll}/u.test(old) && /\p{Lu}/u.test(c);
		if (boundary || !alpha || (/\s/u.test(c) && c !== " ")) out += " ";
		if (alpha || c === " ") out += t(c);
		old = c;
		i += c.length;
	}
	return out.trim().replace(SPACES, sep);
}

const lower = (c: string): string => c.toLowerCase();
const upper = (c: string): string => c.toUpperCase();

/** Space-separated lower case. */
export function simple(s: string): string {
	return removeCase(s, " ", lower);
}

/** Dash-separated lower case, as in `kebab-case`. */
export function dash(s: string): string {
	return removeCase(s, "-", lower);
}

/** Underscore-separated lower case. */
export function snake(s: string): string {
	return removeCase(s, "_", lower);
}

/** Underscore-separated upper case. */
export function constant(s: string): string {
	return removeCase(s, "_", upper);
}

/** `PascalCase`. */
export function pascal(s: string): string {
	let out = "";
	let wasSpace = false;
	let i = 0;
	for (const raw of removeCase(s, " ", lower)) {
		const c: string = i === 0 || wasSpace ? raw.toUpperCase() : raw;
		wasSpace = c === " ";
		if (!wasSpace) out += c;
		i += raw.length;
	}
	return out;
}

/** `camelCase`. */
export function camel(s: string): string {
	let first = " ";
	for (const c of s) {
		if (/[\p{L}\p{N}]/u.test(c)) {
			first = c;
			break;
		}
	}
	const body = pascal(s);
	if (strLen(body) > 1) return (first.toLowerCase() + body.slice(1)).trim();
	return s;
}
