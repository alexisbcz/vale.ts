/**
 * `conditional`: the presence of one pattern requires the presence of another
 * -- an abbreviation that has to be defined before it is used.
 */

import type { Alert, Block, Config, File } from "@vale-ts/core";
import { newE201FromTarget } from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	buildPhraseRe,
	checkScopes,
	type Definition,
	isMatch,
	makeAlert,
	re2Loc,
	readDefinition,
	readStructureError,
	type Rule,
	updateExceptions,
	withinPhrase,
} from "./definition.ts";
import { patternError } from "./pattern-error.ts";
import { stringInSlice } from "./util.ts";

export class Conditional implements Rule {
	private readonly definition: Definition;

	readonly exceptions: string[];
	readonly first: string;
	readonly second: string;
	/**
	 * `in` names the View scope `second` is looked for in. Without it,
	 * `second` is looked for in the same block as `first`.
	 */
	readonly in: string;
	readonly ignorecase: boolean;
	readonly vocab: boolean;

	private readonly exceptRe: Regexp | null;
	private readonly phraseRe: Regexp | null;
	private readonly patterns: Regexp[];

	/**
	 * Whether `second` has a capture group.
	 *
	 * With one, a `first` match is allowed only if its value was captured by a
	 * `second` match -- an acronym defined as `... (WHO)`. Without one, the
	 * rule is a plain presence check: any `first` requires `second` to appear
	 * somewhere in the same block.
	 */
	private readonly secondHasGroup: boolean;

	constructor(cfg: Config | null, generic: BaseCheck, path: string) {
		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.exceptions = f.strings("exceptions");
			this.first = f.string("first");
			this.second = f.string("second");
			this.in = f.string("in");
			this.ignorecase = f.bool("ignorecase");
			this.vocab = f.bool("vocab", true);
			f.done();
		} catch (err) {
			throw readStructureError(err, path);
		}

		checkScopes(this.definition.scope, path);

		if (this.in !== "" && !viewDefinesScope(cfg, this.in)) {
			throw newE201FromTarget(
				`no View defines a scope named '${this.in}'`,
				"in",
				path,
			);
		}

		const accepted = cfg?.acceptedTokens ?? [];
		try {
			this.exceptRe = updateExceptions(this.exceptions, accepted, this.vocab);
		} catch (err) {
			throw patternError(err, path, ...this.exceptions);
		}
		this.phraseRe = buildPhraseRe(this.exceptions, accepted, this.vocab);

		let consequent: Regexp;
		try {
			consequent = Regexp.compile(this.second);
		} catch (err) {
			throw patternError(err, path, this.second);
		}
		this.secondHasGroup = hasCaptureGroup(this.second);

		let antecedent: Regexp;
		try {
			antecedent = Regexp.compile(this.first);
		} catch (err) {
			throw patternError(err, path, this.first);
		}

		this.patterns = [consequent, antecedent];
	}

	run(blk: Block, file: File | null, cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];

		const txt = blk.text;

		// Every alert this rule raises, on either branch below, comes from a
		// match of the antecedent -- so if that cannot match, there is nothing
		// to flag.
		//
		// It has to be the antecedent and not the consequent: the rule fires
		// when the consequent is *absent*, so ruling the block out on the
		// consequent would suppress exactly the alerts it exists to raise.
		if (!this.patterns[1]!.mightMatch(blk.lower)) return alerts;

		// The consequent is looked for in this block, or, with `in`, in the
		// values of another of the View's scopes.
		let sources: string[] = [txt];
		if (this.in !== "") sources = file?.scoped[this.in] ?? [];

		if (!this.secondHasGroup) {
			for (const src of sources) {
				if (this.patterns[0]!.test(src)) return alerts;
			}
			return this.flagAntecedents(blk, cfg);
		}

		// The consequent first. Ensuring that an abbreviation is defined
		// parenthetically means `World Health Organization (WHO)` defines the
		// `WHO` that may follow it.
		for (const src of sources) {
			for (const mat of this.patterns[0]!.findAllStringSubmatch(src, -1)) {
				for (const m of mat.slice(1)) {
					if (m.length > 0) file?.sequences.push(m);
				}
			}
		}

		// Then the antecedent.
		for (const loc of this.patterns[1]!.findAllStringIndex(txt, -1)) {
			const s = re2Loc(blk, loc);
			const defined = file !== null && stringInSlice(s, file.sequences);

			if (
				!defined &&
				!isMatch(this.exceptRe, s) &&
				!withinPhrase(this.phraseRe, txt, loc)
			) {
				alerts.push(makeAlert(this.definition, [...loc], blk, cfg));
			}
		}

		return alerts;
	}

	/**
	 * Reports every `first` match, for the presence check when `second` is
	 * absent from the block.
	 */
	private flagAntecedents(blk: Block, cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];
		const txt = blk.text;
		for (const loc of this.patterns[1]!.findAllStringIndex(txt, -1)) {
			const s = re2Loc(blk, loc);
			if (isMatch(this.exceptRe, s) || withinPhrase(this.phraseRe, txt, loc)) {
				continue;
			}
			alerts.push(makeAlert(this.definition, [...loc], blk, cfg));
		}
		return alerts;
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return "";
	}
}

/** Whether any View names a scope `name`. */
function viewDefinesScope(cfg: Config | null, name: string): boolean {
	if (cfg === null) return false;
	for (const view of Object.values(cfg.views)) {
		for (const s of view.scopes) {
			if (s.name === name) return true;
		}
	}
	return false;
}

/**
 * Whether `pattern` holds a capturing group -- an unescaped `(` that does not
 * begin a non-capturing or extension group `(?...)`.
 *
 * Reading a `(` inside a character class as a group turned a presence check
 * into a definition check, and a `second` written as `^\w+(?:\([^()]*\))?!:`
 * then never matched.
 */
export function hasCaptureGroup(pattern: string): boolean {
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "\\") {
			// An escape takes the next character with it: `\(` is a literal
			// paren, and `\[` never opens a class.
			i++;
		} else if (c === "[") {
			inClass = true;
		} else if (c === "]") {
			inClass = false;
		} else if (c === "(") {
			if (inClass) {
				// A paren inside a character class, `[^()]`, is a member of
				// the class and not a group.
				continue;
			}
			if (i + 1 < pattern.length && pattern[i + 1] === "?") {
				// `(?:`, `(?=`, `(?<=`, `(?i)`: not captures. A named group,
				// `(?<name>` or `(?P<name>`, is one.
				const rest = pattern.slice(i + 2);
				if (rest.startsWith("P<")) return true;
				if (
					rest.startsWith("<") &&
					!rest.startsWith("<=") &&
					!rest.startsWith("<!")
				) {
					return true;
				}
				continue;
			}
			return true;
		}
	}
	return false;
}
