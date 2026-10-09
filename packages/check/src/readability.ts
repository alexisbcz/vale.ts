/**
 * `readability`: reports text above a reading-grade threshold.
 */

import type { Alert, Block, Config, File } from "@vale-ts/core";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	type Definition,
	formatMessages,
	readDefinition,
	readStructureError,
	type Rule,
} from "./definition.ts";
import { measuredScope } from "./metric.ts";
import { allStringsInSlice, stringInSlice } from "./util.ts";
import { READABILITY_METRICS } from "./variables.ts";

export class Readability implements Rule {
	private readonly definition: Definition;

	/**
	 * `metrics` (`array`): one or more of Gunning Fog, Coleman-Liau,
	 * Flesch-Kincaid, SMOG and Automated Readability.
	 */
	readonly metrics: string[];
	/** `grade` (`float`): the highest acceptable score. */
	readonly grade: number;

	constructor(_cfg: Config | null, generic: BaseCheck, path: string) {
		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.metrics = f.strings("metrics");
			this.grade = f.float("grade");
			f.done();
		} catch (err) {
			throw readStructureError(err, path);
		}

		if (allStringsInSlice(this.metrics, READABILITY_METRICS)) {
			this.definition.scope = measuredScope(this.definition.scope);
		} else if (this.definition.scope.length === 0) {
			// A rule naming a metric this check does not know has always run
			// on `text`, the default an unset scope used to compile to.
			this.definition.scope = ["text"];
		}
	}

	run(blk: Block, _file: File | null, _cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];

		const doc = blk.summarize();
		let grade = 0;

		if (stringInSlice("SMOG", this.metrics)) grade += doc.smog();
		if (stringInSlice("Gunning Fog", this.metrics)) grade += doc.gunningFog();
		if (stringInSlice("Coleman-Liau", this.metrics)) grade += doc.colemanLiau();
		if (stringInSlice("Flesch-Kincaid", this.metrics)) {
			grade += doc.fleschKincaid();
		}
		if (stringInSlice("Automated Readability", this.metrics)) {
			grade += doc.automatedReadability();
		}

		grade /= this.metrics.length;
		if (grade > this.grade) {
			const a: Alert = {
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
			[a.message, a.description] = formatMessages(
				this.definition.message,
				this.definition.description,
				grade.toFixed(2),
			);
			alerts.push(a);
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
