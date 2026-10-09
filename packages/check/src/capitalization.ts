/**
 * `capitalization`: reports a block whose case does not match the style the
 * rule names -- `$title`, `$sentence`, `$lower`, `$upper`, or a pattern.
 */

import type { Action, Alert, Block, Config, File } from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";
import { anchor } from "./anchor.ts";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	checkScopes,
	type Definition,
	formatMessages,
	isMatch,
	makeAlert,
	readDefinition,
	readStructureError,
	type Rule,
	updateExceptions,
} from "./definition.ts";
import { patternError } from "./pattern-error.ts";
import {
	chicagoStyle,
	apStyle,
	SentenceConverter,
	TitleConverter,
} from "./strcase.ts";
import {
	type CheckFunc,
	sentence,
	title,
	VAR_TO_FUNC,
	wasIndicator,
} from "./variables.ts";

export class Capitalization implements Rule {
	private readonly definition: Definition;

	/** `match` (`string`): `$title`, `$sentence`, `$lower`, `$upper`, or a pattern. */
	readonly match: string;
	/** `style` (`string`): AP or Chicago; only read when `match` is `$title`. */
	readonly style: string;
	/** `exceptions` (`array`): strings to be ignored. */
	exceptions: string[];
	/** `indicators` (`array`): suffixes after which the next token is ignored. */
	readonly indicators: string[];
	/**
	 * `threshold` (`float`): the least proportion of words that must be
	 * (un)capitalized for a block to count as correct.
	 */
	readonly threshold: number;
	/** `vocab` (`boolean`): read the project's accepted terms as exceptions. */
	readonly vocab: boolean;
	/** `prefix` (`string`): a prefix to leave out of the comparison. */
	readonly prefix: string;

	/** The test `match` compiled to. */
	readonly check: CheckFunc;

	private readonly exceptRe: Regexp | null;

	constructor(cfg: Config | null, generic: BaseCheck, path: string) {
		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.match = f.string("match");
			this.style = f.string("style");
			this.exceptions = f.strings("exceptions");
			this.indicators = f.strings("indicators");
			this.threshold = f.float("threshold");
			this.vocab = f.bool("vocab", true);
			this.prefix = f.string("prefix");
			// `check` is the compiled test, not something a file writes; the
			// key is known so that a definition carrying it is not refused.
			f.ignore("check");
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

		// A threshold of 0 would disable the rule, so it is not a usable
		// default. 0.8 is what the rule did before it had a threshold at all.
		const threshold = this.threshold === 0 ? 0.8 : this.threshold;
		this.threshold = threshold;

		if (this.vocab) this.exceptions = [...this.exceptions, ...accepted];

		if (this.match === "$title") {
			const tc = new TitleConverter(
				this.style === "Chicago" ? chicagoStyle : apStyle,
				{ vocab: this.exceptions, prefix: this.prefix },
			);
			this.check = (s, re) => title(s, re, tc, threshold);
		} else if (this.match === "$sentence") {
			const sc = new SentenceConverter({
				vocab: this.exceptions,
				prefix: this.prefix,
				indicator: wasIndicator(this.indicators),
			});
			this.check = (s, re) => sentence(s, re, sc, threshold);
		} else {
			const byVar = VAR_TO_FUNC[this.match];
			if (byVar !== undefined) {
				this.check = byVar;
			} else {
				let re2: Regexp;
				try {
					re2 = Regexp.compile(this.match);
				} catch (err) {
					throw patternError(err, path, this.match);
				}
				this.check = (s, r) => [re2.pattern, re2.test(s) || isMatch(r, s)];
			}
		}
	}

	run(blk: Block, _file: File | null, cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];

		const [expected, matched] = this.check(blk.text, this.exceptRe);
		if (matched) return alerts;

		const action: Action = {
			name: this.definition.action.name,
			params: [...this.definition.action.params],
		};
		if (action.name === "replace" && action.params.length === 0) {
			// Only the non-pattern styles know what the text should be.
			if (this.match === "$title" || this.match === "$sentence") {
				action.params = [expected];
			}
		}
		// The whole block. Go counts runes here because its spans are rune
		// offsets; this port's spans are string indices, so the span is the
		// text's own length.
		const pos = [0, blk.text.length];

		const a = makeAlert(this.definition, pos, blk, cfg);
		[a.message, a.description] = formatMessages(
			this.definition.message,
			this.definition.description,
			blk.text,
			expected,
		);
		// Set after `makeAlert`, so `matchcase` cannot reach it. That is
		// deliberate: this rule decides the case, and re-casing its suggestion
		// to match the text it is correcting would undo the correction.
		a.action = action;
		if (action.name === "replace") a.suggestions = action.params;

		anchor(a, blk);
		alerts.push(a);

		return alerts;
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return "";
	}
}
