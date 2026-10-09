/**
 * `substitution`: reports a term the style replaces, and suggests what to use
 * instead.
 *
 * The rule's `swap` is a mapping, so the pattern is one alternation of
 * capturing groups -- one per key -- and the group that matched says which
 * value to suggest. That is why so much of this file is about group numbers.
 */

import {
	type Action,
	type Alert,
	type Block,
	type Config,
	capFirst,
	type File,
	literalTerm,
	newE201FromTarget,
	termPattern,
	toSentence,
} from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";
import { affixTokens } from "./affix.ts";
import { anchor } from "./anchor.ts";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	alertFor,
	buildPhraseRe,
	checkScopes,
	type Definition,
	fillTemplate,
	formatMessages,
	IGNORE_CASE,
	isMatch,
	makeRegexp,
	matchToken,
	type Rule,
	re2Loc,
	readDefinition,
	readStructureError,
	updateExceptions,
	vocabAccepts,
	vocabFor,
	withinPhrase,
} from "./definition.ts";
import { recase } from "./matchcase.ts";
import { patternError } from "./pattern-error.ts";
import { fields } from "./util.ts";

export class Substitution implements Rule {
	private readonly definition: Definition;

	readonly exceptions: string[];
	readonly swap: Record<string, string>;
	/** `affix` names the affix file whose flags a `word/FLAGS` key uses. */
	readonly affix: string;
	readonly ignorecase: boolean;
	readonly nonword: boolean;
	readonly vocab: boolean;
	readonly capitalize: boolean;
	/** Deprecated, and read only so that a rule carrying it still loads. */
	readonly pos: string;

	/**
	 * Whether the rule was built from a vocabulary, whose swap values may be
	 * patterns: a match is offered as a fix only when the expected form is
	 * plain text.
	 */
	terms = false;

	private readonly repl: string[];
	private readonly msgMap: string[];
	private readonly exceptRe: Regexp | null;
	private readonly phraseRe: Regexp | null;
	private readonly re: Regexp;

	constructor(cfg: Config | null, generic: BaseCheck, path: string) {
		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.exceptions = f.strings("exceptions");
			this.swap = f.stringMap("swap");
			this.affix = f.string("affix");
			this.ignorecase = f.bool("ignorecase");
			this.nonword = f.bool("nonword");
			this.vocab = f.bool("vocab", true);
			this.capitalize = f.bool("capitalize");
			this.pos = f.string("pos");
			f.done();
		} catch (err) {
			throw readStructureError(err, path);
		}

		checkScopes(this.definition.scope, path);

		if (this.affix !== "") {
			const swap: Record<string, string> = {};
			for (const [key, value] of Object.entries(this.swap)) {
				swap[affixTokens(cfg, this.affix, [key], path)[0]!] = value;
			}
			this.swap = swap;
		}

		const accepted = cfg?.acceptedTokens ?? [];
		try {
			this.exceptRe = updateExceptions(this.exceptions, accepted, this.vocab);
		} catch (err) {
			throw patternError(err, path, ...this.exceptions);
		}
		this.phraseRe = buildPhraseRe(this.exceptions, accepted, this.vocab);

		const template = makeRegexp(
			cfg?.wordTemplate ?? "",
			this.ignorecase,
			() => !this.nonword,
			() => "",
			true,
		);

		// Longest first, so the alternation cannot shadow a longer key with a
		// shorter one that prefixes it.
		const terms = Object.keys(this.swap).sort((a, b) => b.length - a.length);
		const shared = sharedLookaround(terms);

		const replacements: string[] = [];
		this.msgMap = [];
		let tokens = "";
		for (const term of terms) {
			this.msgMap.push(term);
			const replacement = this.swap[term]!;

			let regexstr =
				shared !== "" && term.startsWith(shared) ? term.slice(shared.length) : term;

			const opens = count(regexstr, "(");
			if (opens !== count(regexstr, "(?") + count(regexstr, "\\(")) {
				// A capturing group of the term's own would shift the group
				// numbers the replacements are keyed on.
				try {
					regexstr = convertCaptureGroups(regexstr);
				} catch (err) {
					throw newE201FromTarget(
						err instanceof Error ? err.message : String(err),
						regexstr,
						path,
					);
				}
			}
			tokens += `(${regexstr})|`;
			replacements.push(replacement);
		}

		tokens = tokens.replace(/\|+$/, "");
		if (shared !== "") tokens = `${shared}(?:${tokens})`;

		const regex = fillTemplate(template, tokens);
		try {
			this.re = Regexp.compile(regex);
		} catch (err) {
			throw patternError(err, path, ...terms);
		}

		this.repl = replacements;
	}

	run(blk: Block, file: File | null, cfg: Config | null): Alert[] {
		const vocab = vocabFor(cfg, file);
		const alerts: Alert[] = [];

		const txt = blk.text;
		// Two cheap tests before the expensive one. This looks like a wasted
		// scan on a block that does match, and was measured as the cheaper
		// arrangement anyway: `test` stops at the first hit, and a block with
		// no match skips the allocation the submatch walk makes.
		if (!this.re.mightMatch(blk.lower) || !this.re.test(txt)) return alerts;

		for (const submat of this.re.findAllStringSubmatchIndex(txt, -1)) {
			for (let idx = 0; idx < submat.length; idx++) {
				const mat = submat[idx]!;
				if (mat === -1 || idx === 0 || idx % 2 !== 0) continue;

				const loc = [mat, submat[idx + 1]!];
				const observed = re2Loc(blk, loc);
				let expected = this.subMsg(idx / 2 - 1, observed);

				// Whether `observed` is already acceptable. For a `replace`
				// action the swap value is literal replacement text -- one or
				// more `|`-separated suggestions -- so each option is compared
				// literally; otherwise an option like `...` would read as a
				// pattern matching any three characters and suppress a real
				// finding.
				//
				// For a non-`replace` rule the value may instead be a pattern
				// describing the acceptable forms, such as a vocabulary term
				// `[pP]y.*\b`, which is still matched as one.
				let same: boolean;
				if (this.definition.action.name === "replace") {
					same = getOptions(expected).includes(observed);
				} else if (this.terms) {
					// A phrase may wrap across a line where the term has a space.
					same = matchToken(termPattern(expected), observed, false);
				} else {
					same = matchToken(expected, observed, false);
				}

				if (
					!same &&
					!isMatch(this.exceptRe, observed) &&
					!withinPhrase(this.phraseRe, txt, loc) &&
					!vocabAccepts(vocab, observed, txt, loc)
				) {
					const action: Action = {
						name: this.definition.action.name,
						params: [...this.definition.action.params],
					};
					let message = this.definition.message;

					if (action.name === "replace" && action.params.length === 0) {
						action.params = getOptions(expected);
						if (this.capitalize && observed === capFirst(observed)) {
							action.params = action.params.map(capFirst);
						}
						if (this.definition.matchCase) {
							action.params = recase(action.params, observed);
						}

						expected = toSentence(action.params, "or");
						// Kept for compatibility: a message written with two
						// quoted placeholders must not end up double-quoting.
						message = convertMessage(message);
					} else if (action.name !== "replace") {
						// For a non-`replace` rule the swap value may be a
						// pattern describing the term. Show the observed text
						// re-cased to the term's canonical form rather than the
						// raw pattern -- `OAuth2?` becomes `OAuth2`.
						expected = recaseToTerm(expected, observed);
					}

					const a = alertFor(this.definition, loc, observed, cfg);

					[a.message, a.description] = formatMessages(
						message,
						this.definition.description,
						expected,
						observed,
					);
					a.action = action;
					if (action.name === "replace") {
						a.suggestions = action.params;
					} else if (this.terms && expected !== observed && literalTerm(expected)) {
						a.action = {
							name: "replace",
							params: [keepWrap(expected, observed)],
						};
						a.suggestions = a.action.params;
					}

					anchor(a, blk);
					alerts.push(a);
				}

				// An alternation sets exactly one group, so the rest of the
				// slots only hold -1. Reading them is free per slot and not
				// free per match when a rule has hundreds of swaps.
				break;
			}
		}

		return alerts;
	}

	/**
	 * The replacement for the group that matched, with the group references
	 * its text may hold filled in.
	 */
	private subMsg(index: number, observed: string): string {
		let expected = this.repl[index] ?? "";
		if (this.capitalize && observed === capFirst(observed)) {
			expected = capFirst(expected);
		}

		if (!/\$\d+/.test(expected)) return expected;

		let msg = this.msgMap[index] ?? "";
		if (this.ignorecase) msg = IGNORE_CASE + msg;

		return Regexp.mustCompile(msg).replace(observed, expected, -1, -1);
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return this.re.pattern;
	}
}

function count(s: string, sub: string): number {
	let n = 0;
	let at = 0;
	for (;;) {
		const i = s.indexOf(sub, at);
		if (i < 0) return n;
		n++;
		at = i + sub.length;
	}
}

/**
 * A leading lookaround every term begins with.
 *
 * A lookaround is zero-width, so asserting it once ahead of the alternation is
 * the same as asserting it in every branch -- and costs one evaluation per
 * position instead of one per term. Nothing capturing is hoisted, so the group
 * numbers the replacements are keyed on stay put.
 */
export function sharedLookaround(terms: readonly string[]): string {
	if (terms.length < 2) return "";

	const lead = leadingGroup(terms[0]!);
	if (lead === "" || count(lead, "(") !== count(lead, "(?") + count(lead, "\\(")) {
		return "";
	}

	for (const t of terms.slice(1)) {
		if (!t.startsWith(lead)) return "";
	}

	return lead;
}

/** The lookaround `expr` opens with, brackets included. */
function leadingGroup(expr: string): string {
	if (
		!expr.startsWith("(?=") &&
		!expr.startsWith("(?!") &&
		!expr.startsWith("(?<=") &&
		!expr.startsWith("(?<!")
	) {
		return "";
	}

	let depth = 0;
	for (let i = 0; i < expr.length; i++) {
		const c = expr[i]!;
		if (c === "\\") i++;
		else if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return expr.slice(0, i + 1);
		}
	}

	return "";
}

/**
 * The literal characters of a pattern, in order, or `""` when the pattern uses
 * constructs that cannot be reduced to one fixed-length literal.
 *
 * A trailing `?` -- one optional character -- is allowed; the optional
 * character is kept, and callers fall back when the length does not line up
 * with the observed text.
 */
export function literalSkeleton(pattern: string): string {
	let out = "";
	const runes = [...pattern];
	for (let i = 0; i < runes.length; i++) {
		const r = runes[i]!;
		if (r === "\\") {
			// An escaped literal: the next character, verbatim.
			if (i + 1 >= runes.length) return "";
			out += runes[i + 1]!;
			i++;
		} else if (r === "?") {
			// The previous character is already written; nothing to add.
		} else if ("[](){}|.*+^$".includes(r)) {
			return "";
		} else {
			out += r;
		}
	}
	return out;
}

/**
 * Alternations multiply out fast; past a handful the term is no longer one word
 * spelled several ways.
 */
const MAX_EXPANSIONS = 64;

/**
 * Every spelling a vocabulary term can match -- `OAuth2?` gives OAuth2 and
 * OAuth -- or null when the pattern is not a finite set.
 */
export function expandPattern(pattern: string): string[] | null {
	const runes = [...pattern];

	/** Reads an alternation at `i`, returning its spellings and where it ended. */
	const parse = (start: number, nested: boolean): [string[], number, boolean] => {
		const branches: string[] = [];
		let current: string[] = [""];
		let i = start;

		const cross = (add: readonly string[]): boolean => {
			if (current.length * add.length > MAX_EXPANSIONS) return false;
			const next: string[] = [];
			for (const prefix of current) {
				for (const suffix of add) next.push(prefix + suffix);
			}
			current = next;
			return true;
		};

		while (i < runes.length) {
			let atom: string[];

			const r = runes[i]!;
			if (r === ")") {
				if (!nested) return [[], 0, false]; // unbalanced
				return [[...branches, ...current], i + 1, true];
			}
			if (r === "|") {
				branches.push(...current);
				current = [""];
				i++;
				continue;
			}
			if (r === "(") {
				let inner = i + 1;
				// Capturing or not makes no difference to the spellings.
				if (runes.slice(inner).join("").startsWith("?:")) inner += 2;
				else if (inner < runes.length && runes[inner] === "?") {
					return [[], 0, false]; // lookaround, named group, flags
				}
				const [got, next, ok] = parse(inner, true);
				if (!ok) return [[], 0, false];
				atom = got;
				i = next;
			} else if (r === "\\") {
				if (i + 1 >= runes.length) return [[], 0, false];
				// `\d`, `\w`, `\b` are not fixed spellings.
				const next = runes[i + 1]!;
				if (/[\p{L}\p{Nd}]/u.test(next)) return [[], 0, false];
				atom = [next];
				i += 2;
			} else if ("[]{}.*+^$".includes(r)) {
				return [[], 0, false];
			} else {
				atom = [r];
				i++;
			}

			// `?` makes the atom optional: the empty spelling joins it.
			if (i < runes.length && runes[i] === "?") {
				atom = [...atom, ""];
				i++;
			} else if (
				i < runes.length &&
				(runes[i] === "*" || runes[i] === "+" || runes[i] === "{")
			) {
				return [[], 0, false];
			}

			if (!cross(atom)) return [[], 0, false];
		}

		if (nested) return [[], 0, false]; // unterminated group
		return [[...branches, ...current], i, true];
	};

	const [out, next, ok] = parse(0, false);
	if (!ok || next !== runes.length || out.length === 0) return null;

	return out;
}

/**
 * Computed once per term, not once per alert; a run can raise hundreds of
 * thousands against the same few terms.
 */
const expansions = new Map<string, string[] | null>();

function expansionsFor(term: string): string[] | null {
	if (expansions.has(term)) return expansions.get(term) ?? null;

	let out = expandPattern(term);
	if (out === null) {
		const skel = literalSkeleton(term);
		if (skel !== "") out = [skel];
	}

	expansions.set(term, out);
	return out;
}

/**
 * Re-cases `observed` to a vocabulary term's canonical spelling: `OAuth2?`
 * against `Oauth` gives `OAuth`.
 *
 * The term is returned unchanged when no spelling matches, so the raw pattern
 * is only ever a last resort.
 */
export function recaseToTerm(term: string, observed: string): string {
	const unwrapped = fields(observed).join(" ");
	for (const candidate of expansionsFor(term) ?? []) {
		if (candidate.toLowerCase() === unwrapped.toLowerCase()) return candidate;
	}
	return term;
}

const WRAP_GAPS = /\s+/g;

/**
 * `expected` with the whitespace `observed` has between its words, so a fix to
 * a phrase that wraps across a line keeps the wrap.
 */
export function keepWrap(expected: string, observed: string): string {
	const words = fields(expected);
	const gaps = observed.match(WRAP_GAPS) ?? [];
	if (gaps.length !== words.length - 1) return expected;

	let out = "";
	for (let i = 0; i < words.length; i++) {
		if (i > 0) out += gaps[i - 1]!;
		out += words[i]!;
	}
	return out;
}

/** Collapses a doubly quoted placeholder, for a message written either way. */
export function convertMessage(s: string): string {
	let out = s;
	for (const spec of ["'%s'", '"%s"']) {
		if (count(out, spec) === 2) out = out.replace(spec, "%s");
	}
	return out;
}

/** Makes every capturing group of a term non-capturing. */
export function convertCaptureGroups(msg: string): string {
	const captureOpen = Regexp.mustCompile(String.raw`(?<!\\)\((?!\?)`);
	return captureOpen.replace(msg, "(?:", -1, -1);
}

/** Separates a suggestion's options: a `|` not preceded by a backslash. */
const RE_UNESCAPED_PIPE = Regexp.mustCompile(String.raw`(?<!\\)\|`);

/**
 * The options a swap value offers.
 *
 * `a|b|c` gives `a`, `b` and `c`, which is how a rule offers more than one
 * suggestion for a single match. An escaped `\|` is a literal pipe.
 */
export function getOptions(match: string): string[] {
	const options: string[] = [];
	for (const option of RE_UNESCAPED_PIPE.split(match, -1)) {
		if (option !== "") options.push(option.replaceAll("\\|", "|"));
	}
	return options;
}
