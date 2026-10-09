/**
 * Choosing an output format.
 *
 * `CLI`, `line` and `JSON` are built in; anything else names a template.
 */

import type { Config, File } from "@vale-ts/core";
import { printVerboseAlerts } from "./color.ts";
import { printCustomAlerts } from "./custom.ts";
import { printJSONAlerts } from "./json.ts";
import { printLineAlerts } from "./line.ts";

/** Prints the alerts in the format the flags asked for. */
export function printAlerts(linted: File[], config: Config): boolean {
	const files = config.flags.sorted
		? [...linted].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		: linted;

	switch (config.flags.output) {
		case "JSON":
			return printJSONAlerts(files);
		case "line":
			return printLineAlerts(files, config.flags.relative);
		case "CLI":
			return printVerboseAlerts(files);
		default:
			return printCustomAlerts(files, config);
	}
}
