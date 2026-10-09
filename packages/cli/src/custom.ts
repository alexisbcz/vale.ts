/**
 * `--output=<path>`: the report a user-supplied Go template renders.
 *
 * The template is found on the configuration's search paths when it is not a
 * path that exists, so `--output=line.tmpl` picks up the one a package shipped
 * under `config/templates`.
 *
 * The data handed to it is Go's: a list of files, each with its `Path` and its
 * `Alerts`, and the run's `LintedTotal`. Field names are Go's too, since a
 * template written for Vale names them.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Alert, Config, File } from "@vale-ts/core";
import { fileExists, findAsset, newE100 } from "@vale-ts/core";
import { FUNCS } from "./funcs.ts";
import { stdout } from "./out.ts";
import { Template } from "./template.ts";

/** One alert, with the field names a template refers to. */
function templateAlert(a: Alert): Record<string, unknown> {
	return {
		Action: { Name: a.action.name, Params: a.action.params },
		Suggestions: a.suggestions,
		Groups: a.groups ?? [],
		Span: a.span,
		Check: a.check,
		Description: a.description,
		Link: a.link,
		Message: a.message,
		Severity: a.severity,
		Match: a.match,
		Line: a.line,
	};
}

/** Renders the alerts through the template, and reports whether any erred. */
export function printCustomAlerts(linted: readonly File[], cfg: Config): boolean {
	let found = cfg.flags.output;
	if (!fileExists(found)) found = findAsset(cfg, found);

	let text: string;
	try {
		text = readFileSync(found, "utf8");
	} catch (err) {
		throw newE100("template", err);
	}

	let template: Template;
	try {
		template = new Template(text, path.basename(found), FUNCS);
	} catch (err) {
		throw newE100("template", err);
	}

	let errors = 0;
	const files: unknown[] = [];

	for (const f of linted) {
		if (f.alerts.length === 0) continue;

		const sorted = f.sortedAlerts();
		for (const a of sorted) {
			// One per file, as upstream counts it: the `break` makes this
			// "files holding an error" rather than "errors".
			if (a.severity === "error") {
				errors++;
				break;
			}
		}

		files.push({ Alerts: sorted.map(templateAlert), Path: f.path });
	}

	try {
		template.execute({ Files: files, LintedTotal: linted.length }, stdout);
	} catch (err) {
		throw newE100("template", err);
	}

	return errors !== 0;
}
