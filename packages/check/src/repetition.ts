/**
 * `repetition`: reports a token that follows an identical one -- "this this".
 */

import {
	type Alert,
	type Block,
	type Config,
	type File,
	isLetter,
} from "@vale-ts/core";
import { segmentText } from "@vale-ts/nlp";
import { Regexp } from "@vale-ts/regex";
import { anchor } from "./anchor.ts";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	buildPhraseRe,
	checkScopes,
	type Definition,
	formatMessages,
	IGNORE_CASE,
	isMatch,
	makeAlert,
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

export class Repetition implements Rule {
	private readonly definition: Definition;

	readonly tokens: string[];
	readonly max: number;
	readonly ignorecase: boolean;
	readonly alpha: boolean;
	readonly vocab: boolean;
	readonly exceptions: string[];

	private readonly exceptRe: Regexp | null;
	private readonly phraseRe: Regexp | null;
	private readonly re: Regexp;

	constructor(cfg: Config | null, generic: BaseCheck, path: string) {
		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.tokens = f.strings("tokens");
			this.max = f.int("max");
			this.ignorecase = f.bool("ignorecase");
			this.alpha = f.bool("alpha");
			this.vocab = f.bool("vocab", true);
			this.exceptions = f.strings("exceptions");
			f.done();
		} catch (err) {
			throw readStructureError(err, path);
		}

		checkScopes(this.definition.scope, path);

		const accepted = cfg?.acceptedTokens ?? [];
		try {
			this.exceptRe = updateExceptions(this.exceptions, accepted, this.vocab);
		} catch (err) {
			throw patternError(err, path, ...this.exceptions);
		}
		this.phraseRe = buildPhraseRe(this.exceptions, accepted, this.vocab);

		const regex = `${this.ignorecase ? IGNORE_CASE : ""}(${this.tokens.join("|")})`;
		try {
			this.re = Regexp.compile(regex);
		} catch (err) {
			throw patternError(err, path, ...this.tokens);
		}
	}

	run(blk: Block, file: File | null, cfg: Config | null): Alert[] {
		const vocab = vocabFor(cfg, file);
		const alerts: Alert[] = [];

		let prev = "";
		let ploc: readonly number[] = [];
		let count = 0;

		const txt = blk.text;
		for (const loc of this.re.findAllStringIndex(txt, -1)) {
			const curr = re2Loc(blk, loc).trim();

			let hit = this.ignorecase
				? curr.toLowerCase() === prev.toLowerCase() && curr !== ""
				: curr === prev && curr !== "";

			hit = hit && (!this.alpha || isLetter(curr));
			if (hit) count++;

			if (hit && count > this.max) {
				const floc = [ploc[0]!, loc[1]];
				const converted = re2Loc(blk, floc);

				// More than one sentence is a false positive: "I almost forgot
				// about that. That is important."
				if (segmentText(converted).length === 1) {
					if (
						!isMatch(this.exceptRe, converted) &&
						!withinPhrase(this.phraseRe, txt, floc) &&
						!vocabAccepts(vocab, converted, txt, floc)
					) {
						const a = makeAlert(this.definition, floc, blk, cfg);
						[a.message, a.description] = formatMessages(
							this.definition.message,
							this.definition.description,
							curr,
						);
						anchor(a, blk);
						alerts.push(a);
						count = 0;
					}
				}
			}
			ploc = loc;
			prev = curr;
		}

		return alerts;
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return this.re.pattern;
	}
}
