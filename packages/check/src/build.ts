/**
 * Turning a rule definition into a rule.
 *
 * The dispatch lives here rather than in `definition.ts` so that the rule
 * modules can depend on the shared machinery without depending on each other.
 */

import { type Config, newE100, newE201FromTarget } from "@vale-ts/core";
import { checkAction, flattenAction } from "./action.ts";
import { Capitalization } from "./capitalization.ts";
import { Conditional } from "./conditional.ts";
import { Consistency } from "./consistency.ts";
import type { BaseCheck } from "./decode.ts";
import { EXTENSION_POINTS, type Rule } from "./definition.ts";
import { Existence } from "./existence.ts";
import { Metric } from "./metric.ts";
import { Occurrence } from "./occurrence.ts";
import { Readability } from "./readability.ts";
import { Repetition } from "./repetition.ts";
import { Script } from "./script.ts";
import { Sequence } from "./sequence.ts";
import { Spelling } from "./spelling.ts";
import { Substitution } from "./substitution.ts";

/** Builds a rule, and checks its action before any alert depends on it. */
export function buildRule(cfg: Config | null, generic: BaseCheck): Rule {
	const path = generic.path;
	if (typeof path !== "string") {
		throw newE100(
			"internal",
			new Error(`'${JSON.stringify(generic)}' is not valid`),
		);
	}

	const rule = newRule(cfg, generic, path);

	// A bad action would otherwise surface as a lint-time error, once the rule
	// had already fired, with no file or line to point at.
	try {
		checkAction(cfg, rule);
	} catch (err) {
		if (path === "internal") throw newE100("internal", err);
		throw newE201FromTarget(
			err instanceof Error ? err.message : String(err),
			"action",
			path,
		);
	}

	return rule;
}

function newRule(cfg: Config | null, generic: BaseCheck, path: string): Rule {
	const name = typeof generic.extends === "string" ? generic.extends : "unknown";

	delete generic.path;
	flattenAction(generic);
	// A rule may carry its own cases; they are for `vale test`, not the
	// compiler.
	delete generic.tests;

	switch (name) {
		case "existence":
			return new Existence(cfg, generic, path);
		case "substitution":
			return new Substitution(cfg, generic, path);
		case "capitalization":
			return new Capitalization(cfg, generic, path);
		case "occurrence":
			return new Occurrence(cfg, generic, path);
		case "spelling":
			return new Spelling(cfg, generic, path);
		case "repetition":
			return new Repetition(cfg, generic, path);
		case "readability":
			return new Readability(cfg, generic, path);
		case "conditional":
			return new Conditional(cfg, generic, path);
		case "consistency":
			return new Consistency(cfg, generic, path);
		case "sequence":
			return new Sequence(cfg, generic, path);
		case "metric":
			return new Metric(cfg, generic, path);
		case "script":
			return new Script(cfg, generic, path);
		default:
			throw newE201FromTarget(
				`'extends' key must be one of [${EXTENSION_POINTS.join(" ")}].`,
				name,
				path,
			);
	}
}
