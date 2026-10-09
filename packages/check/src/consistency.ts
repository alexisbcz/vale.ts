/**
 * `consistency`: reports a document that uses both of two interchangeable
 * spellings.
 */

import type { Alert, Block, Config, File } from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	checkScopes,
	type Definition,
	fillTemplate,
	makeAlert,
	makeRegexp,
	readDefinition,
	readStructureError,
	type Rule,
} from "./definition.ts";
import { patternError } from "./pattern-error.ts";
import { allStringsInSlice } from "./util.ts";

interface Step {
	pattern: Regexp;
	subs: [string, string];
}

export class Consistency implements Rule {
	private readonly definition: Definition;

	/** `either` (`map`): `option 1: option 2` pairs, of which only one may appear. */
	readonly either: Record<string, string>;
	/** `nonword` (`bool`): removes the default word boundaries (`\b`). */
	readonly nonword: boolean;
	/** `ignorecase` (`bool`): makes all matches case-insensitive. */
	readonly ignorecase: boolean;

	private readonly steps: Step[];

	constructor(cfg: Config | null, generic: BaseCheck, path: string) {
		const name = typeof generic.name === "string" ? generic.name : "";

		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.either = f.stringMap("either");
			this.nonword = f.bool("nonword");
			this.ignorecase = f.bool("ignorecase");
			// This rule reads its fields without refusing a key it does not
			// know, as Go's `WeakDecode` does here rather than `decodeRule`.
		} catch (err) {
			throw readStructureError(err, path);
		}

		checkScopes(this.definition.scope, path);

		const template = makeRegexp(
			cfg?.wordTemplate ?? "",
			this.ignorecase,
			() => !this.nonword,
			() => "",
			true,
		);

		// The capture-group stem is the rule's base name -- the last segment,
		// since the rule may sit in a subdirectory.
		const parts = name.split(".");
		const chkKey = parts[parts.length - 1]!;
		let count = 0;

		this.steps = [];
		// In a fixed order, so the steps run the same way on every run.
		for (const v1 of Object.keys(this.either).sort()) {
			const v2 = this.either[v1]!;
			count += 2;

			const subs: [string, string] = [
				`${chkKey}${count}`,
				`${chkKey}${count + 1}`,
			];

			const chkRE = fillTemplate(
				template,
				`(?P<${subs[0]}>${v1})|(?P<${subs[1]}>${v2})`,
			);

			let re: Regexp;
			try {
				re = Regexp.compile(chkRE);
			} catch (err) {
				throw patternError(err, path, v1, v2);
			}

			this.definition.extends = name;
			this.definition.name = `${name}.${v1}`;
			this.steps.push({ pattern: re, subs });
		}
	}

	run(blk: Block, file: File | null, cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];

		let loc: number[] = [];
		const txt = blk.text;

		for (const s of this.steps) {
			const matches = s.pattern.findAllStringSubmatchIndex(txt, -1);
			const names = s.pattern.subexpNames();
			for (const submat of matches) {
				for (let idx = 0; idx < submat.length; idx++) {
					const mat = submat[idx]!;
					if (mat !== -1 && idx > 0 && idx % 2 === 0) {
						loc = [mat, submat[idx + 1]!];
						file?.sequences.push(names[idx / 2] ?? "");
					}
				}
			}

			if (
				matches.length > 0 &&
				file !== null &&
				allStringsInSlice(s.subs, file.sequences)
			) {
				// Reported under the rule's own name rather than the
				// per-term one, which is what the alert's own name is for.
				const def = { ...this.definition, name: this.definition.extends };

				// Not anchored, deliberately. `loc` is whatever the submatch
				// loop above left behind, which is the *last* match in the
				// block rather than the one being reported; searching for the
				// matched text instead lands on the first occurrence, which is
				// what this check has always reported. The rule fires at most
				// once per block, so there is nothing to gain by anchoring.
				alerts.push(makeAlert(def, loc, blk, cfg));
			}
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
