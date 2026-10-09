/**
 * `--output=JSON`: the alerts of a run, keyed by path.
 *
 * The shape is Go's `core.Alert` as `encoding/json` writes it, which is why the
 * keys are capitalized and in declaration order rather than the port's own
 * naming. An editor plugin reads these bytes, so they are the interface.
 */

import type { Manager } from "@vale-ts/check";
import type { Alert, File } from "@vale-ts/core";
import { println } from "./out.ts";
import { asMap, getJSON } from "./util.ts";

/** One alert, with Go's field names and order. */
export function alertJSON(a: Alert): Record<string, unknown> {
	const out: Record<string, unknown> = {
		Action: {
			Name: a.action.name,
			// A nil `[]string` marshals to `null`, and an action without
			// arguments never has a slice. There is no empty-but-present case
			// to tell apart.
			Params: a.action.params.length === 0 ? null : a.action.params,
		},
		Suggestions: a.suggestions,
	};

	// `json:",omitempty"`: the groups are only there when the token captured
	// something.
	if (a.groups !== undefined && a.groups.length > 0) out.Groups = a.groups;

	out.Span = a.span;
	out.Check = a.check;
	out.Description = a.description;
	out.Link = a.link;
	out.Message = a.message;
	out.Severity = a.severity;
	out.Match = a.match;
	out.Line = a.line;

	return out;
}

/** The alerts of `linted`, keyed by path and sorted the way a Go map is. */
function byPath(linted: readonly File[]): {
	files: unknown;
	errors: number;
} {
	let errors = 0;
	const formatted: Record<string, unknown[]> = {};

	for (const f of linted) {
		for (const a of f.sortedAlerts()) {
			if (a.severity === "error") errors++;
			const list = formatted[f.path] ?? [];
			list.push(alertJSON(a));
			formatted[f.path] = list;
		}
	}

	return { files: asMap(formatted), errors };
}

/** Prints the alerts as `map[path][]Alert`, and reports whether any erred. */
export function printJSONAlerts(linted: readonly File[]): boolean {
	const { files, errors } = byPath(linted);
	println(getJSON(files));
	return errors !== 0;
}

/**
 * Tallies this run's alerts per enabled check, seeding every check the manager
 * loaded with zero.
 *
 * Runtime names -- a consistency rule's per-pair entries -- collapse onto the
 * rule that produced them.
 */
export function countAlerts(
	mgr: Manager,
	linted: readonly File[],
): Record<string, number> {
	const counts: Record<string, number> = {};

	for (const name of mgr.rules().keys()) counts[name] = 0;

	for (const f of linted) {
		for (const a of f.alerts) {
			let name = a.check;
			if (!(name in counts)) name = mgr.ruleForAlert(name);
			counts[name] = (counts[name] ?? 0) + 1;
		}
	}

	return counts;
}

/**
 * The opt-in `--counts` shape: the usual alert map under `files`, plus one
 * entry per enabled check under `counts`.
 *
 * Zeros are the point -- an enabled check that never fires is otherwise
 * invisible, and a dead rule is indistinguishable from a working one.
 */
export function printJSONAlertsWithCounts(
	linted: readonly File[],
	counts: Record<string, number>,
): boolean {
	const { files, errors } = byPath(linted);
	println(getJSON({ files, counts: asMap(counts) }));
	return errors !== 0;
}
