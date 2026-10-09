/**
 * `occurrence`: counts the matches of a pattern within a scope and reports a
 * count outside `min`..`max`.
 */

import {
	type Alert,
	type Block,
	type Config,
	type File,
	formatMessage,
	isCode,
} from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";
import { anchor } from "./anchor.ts";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	checkScopes,
	type Definition,
	IGNORE_CASE,
	makeAlert,
	type Rule,
	re2Loc,
	readDefinition,
	readStructureError,
} from "./definition.ts";
import { patternError } from "./pattern-error.ts";

/** The word a zero-occurrence shortfall is anchored to. */
const RE_FIRST_WORD = Regexp.mustCompile(String.raw`\S+`);

export class Occurrence implements Rule {
	private readonly definition: Definition;

	readonly token: string;
	readonly max: number;
	readonly min: number;
	readonly ignorecase: boolean;

	private readonly re: Regexp;

	constructor(_cfg: Config | null, generic: BaseCheck, path: string) {
		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.token = f.string("token");
			this.max = f.int("max");
			this.min = f.int("min");
			this.ignorecase = f.bool("ignorecase");
			f.done();
		} catch (err) {
			throw readStructureError(err, path);
		}

		checkScopes(this.definition.scope, path);

		const regex = `${this.ignorecase ? IGNORE_CASE : ""}(?:${this.token})`;
		try {
			this.re = Regexp.compile(regex);
		} catch (err) {
			throw patternError(err, path, this.token);
		}
	}

	run(blk: Block, _file: File | null, cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];

		const txt = blk.text;
		const locs = this.re.findAllStringIndex(txt, -1);

		const occurrences = locs.length;
		const tooMany = this.max > 0 && occurrences > this.max;
		const tooFew = this.min > 0 && occurrences < this.min;
		if (!tooMany && !tooFew) return alerts;

		let a: Alert;
		if (occurrences === 0) {
			// Zero matches leave no occurrence to point at, but the scope that
			// fell short has a position of its own. Anchored to its first word,
			// the alert lands on the deficient paragraph; unlocated, it
			// collapsed onto line one, where one report hid every other scope
			// that fell short too.
			a = {
				action: { name: "", params: [] },
				suggestions: [],
				check: this.definition.name,
				severity: this.definition.level,
				span: [1, 1],
				link: this.definition.link,
				description: "",
				message: "",
				match: "",
				line: 0,
			};

			const word = RE_FIRST_WORD.findAllStringIndex(txt, 1);
			if (word.length === 1) {
				a = makeAlert(this.definition, [...word[0]!], blk, cfg);
				anchor(a, blk);
			}
		} else {
			// The first non-code match, rather than simply the first: a first
			// match inside a code-like token is a false position. The whole
			// scope cannot be used either, since that risks falling back to a
			// text search.
			let span: number[] = [];
			for (const loc of locs) {
				let m: string;
				try {
					m = re2Loc(blk, loc);
				} catch {
					continue;
				}
				if (m.trim() === "") continue;
				if (!isCode(m)) {
					span = [...loc];
					break;
				}
			}

			// With no non-code match there is nothing to point at; the
			// alternative is `scope: raw`.
			if (span.length === 0) return alerts;

			a = makeAlert(this.definition, span, blk, cfg);
			// Only this branch: the zero-occurrence case above reports a line
			// number, not a span into the text.
			anchor(a, blk);
		}

		// The count goes in as a string, which `formatMessage` renders for
		// either `%d` or `%s`, so a message may use whichever reads better.
		a.message = formatMessage(this.definition.message, String(occurrences));
		a.description = formatMessage(this.definition.description, String(occurrences));
		alerts.push(a);

		return alerts;
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return this.re.pattern;
	}
}
