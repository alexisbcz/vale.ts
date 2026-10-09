/**
 * `existence`: the simplest extension point -- it reports every match of a
 * pattern built from the rule's tokens.
 */

import type { Alert, Block, Config, File } from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";
import { affixTokens } from "./affix.ts";
import { anchor } from "./anchor.ts";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	alertWithGroups,
	buildPhraseRe,
	checkScopes,
	type Definition,
	fillTemplate,
	isMatch,
	makeRegexp,
	type Rule,
	re2Loc,
	readDefinition,
	readStructureError,
	updateExceptions,
	vocabAccepts,
	vocabFor,
	withinPhrase,
} from "./definition.ts";
import { patternError } from "./pattern-error.ts";

/**
 * Where one token's capture groups sit in the joined pattern: its unnamed
 * groups from `unnamed`, its named groups from `named`.
 */
interface GroupSpan {
	unnamed: number;
	unnamedCount: number;
	named: number;
	namedCount: number;
}

export class Existence implements Rule {
	private readonly definition: Definition;

	readonly raw: string[];
	readonly tokens: string[];
	/** `affix` names the affix file whose flags a `word/FLAGS` token uses. */
	readonly affix: string;
	/** `exceptions` (`array`): strings to be ignored. */
	readonly exceptions: string[];
	readonly append: boolean;
	readonly ignoreCase: boolean;
	readonly nonword: boolean;
	readonly vocab: boolean;

	private readonly exceptRe: Regexp | null;
	private readonly phraseRe: Regexp | null;
	private readonly re: Regexp;
	private readonly groups: GroupSpan[];

	constructor(cfg: Config | null, generic: BaseCheck, path: string) {
		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.raw = f.strings("raw");
			this.tokens = f.strings("tokens");
			this.affix = f.string("affix");
			this.exceptions = f.strings("exceptions");
			this.append = f.bool("append");
			this.ignoreCase = f.bool("ignorecase");
			this.nonword = f.bool("nonword");
			this.vocab = f.bool("vocab", true);
			f.done();
		} catch (err) {
			throw readStructureError(err, path);
		}

		checkScopes(this.definition.scope, path);

		this.tokens = affixTokens(cfg, this.affix, this.tokens, path);

		// `vocab` is a list of accepted *words*, so treating it as a set of
		// exceptions only makes sense for word-based rules. A `nonword` rule's
		// tokens match arbitrary spans -- `"[^"]+"[.,]` -- where a vocabulary
		// word would suppress any match that merely *contains* it.
		const accepted = cfg?.acceptedTokens ?? [];
		const readsVocab = this.vocab && !this.nonword;
		try {
			this.exceptRe = updateExceptions(this.exceptions, accepted, readsVocab);
		} catch (err) {
			throw patternError(err, path, ...this.exceptions);
		}
		this.phraseRe = buildPhraseRe(this.exceptions, accepted, readsVocab);

		const template = makeRegexp(
			cfg?.wordTemplate ?? "",
			this.ignoreCase,
			() => !this.nonword && this.tokens.length > 0,
			() => this.raw.join(""),
			this.append,
		);

		const parsed = this.tokens.filter((token) => token.trim() !== "");
		const regex = fillTemplate(template, parsed.join("|"));

		try {
			this.re = Regexp.compile(regex);
		} catch (err) {
			throw patternError(err, path, ...parsed, ...this.raw);
		}
		this.groups = groupSpans(parsed, this.raw.join(""), this.append);
	}

	run(blk: Block, file: File | null, cfg: Config | null): Alert[] {
		const vocab = vocabFor(cfg, file);
		const alerts: Alert[] = [];

		// Rule out the pattern before the engine sees it: almost every rule is
		// asked about text it cannot match, and a substring search is far
		// cheaper than a regular expression. A false answer here is definitive.
		if (!this.re.mightMatch(blk.lower)) return alerts;

		for (const sub of this.re.findAllStringSubmatchIndex(blk.text, -1)) {
			const loc = sub.slice(0, 2);
			const converted = re2Loc(blk, loc);

			const observed = converted.trim();
			if (
				!isMatch(this.exceptRe, observed) &&
				!withinPhrase(this.phraseRe, blk.text, loc) &&
				!vocabAccepts(vocab, observed, blk.text, loc)
			) {
				const a = alertWithGroups(
					this.definition,
					loc,
					converted,
					this.groupsFor(blk, sub),
					cfg,
				);
				anchor(a, blk);
				alerts.push(a);
			}
		}

		return alerts;
	}

	/**
	 * The capture groups of whichever token matched, in that token's own
	 * numbering, or null when the token has none.
	 */
	private groupsFor(blk: Block, sub: readonly number[]): string[] | null {
		for (const span of this.groups) {
			const indices: number[] = [];
			for (let k = 1; k <= span.unnamedCount; k++) indices.push(span.unnamed + k);
			for (let k = 1; k <= span.namedCount; k++) indices.push(span.named + k);

			let matched = false;
			const groups: string[] = [];
			for (const idx of indices) {
				const lo = sub[2 * idx]!;
				const hi = sub[2 * idx + 1]!;
				if (lo === undefined || lo < 0) {
					groups.push("");
					continue;
				}
				try {
					groups.push(re2Loc(blk, [lo, hi]));
				} catch {
					return null;
				}
				matched = true;
			}
			if (matched) return groups;
		}
		return null;
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return this.re.pattern;
	}
}

/**
 * Maps each token's groups into the joined pattern.
 *
 * The engine numbers every unnamed group before any named one, so a token's
 * groups are two runs rather than one.
 */
export function groupSpans(
	tokens: readonly string[],
	raw: string,
	rawLast: boolean,
): GroupSpan[] {
	const pieces = rawLast ? [...tokens, raw] : [raw, ...tokens];

	const spans: GroupSpan[] = [];
	let unnamed = 0;
	let named = 0;
	for (const piece of pieces) {
		const [u, n] = groupCounts(piece);
		spans.push({ unnamed, unnamedCount: u, named, namedCount: n });
		unnamed += u;
		named += n;
	}
	for (const span of spans) span.named += unnamed;

	return rawLast ? spans.slice(0, tokens.length) : spans.slice(1);
}

/** How many unnamed and named groups a pattern has. */
function groupCounts(expr: string): [number, number] {
	if (expr === "") return [0, 0];
	let re: Regexp;
	try {
		re = Regexp.compile(expr);
	} catch {
		return [0, 0];
	}

	let unnamed = 0;
	let named = 0;
	for (const name of re.subexpNames().slice(1)) {
		// An unnamed group has no name here, and Go's engine names it by its
		// number; neither is a name the author wrote.
		if (name === "" || /^\d+$/.test(name)) unnamed++;
		else named++;
	}
	return [unnamed, named];
}
