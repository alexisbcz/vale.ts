/**
 * Named scopes: a name a rule can use where it would otherwise write a scope
 * expression.
 *
 * A named scope is an entry in a YAML mapping under `config/scopes/`, from a
 * name to an expression. Every file found on the search paths is loaded: a
 * package ships its names beside the rules that use them, and nothing in a
 * configuration has to mention them.
 */

import { readFileSync } from "node:fs";
import { parse as parseYAML } from "yaml";
import { newE201FromPosition, newE201FromTarget } from "./errors.ts";

/**
 * The names Vale gives its own scopes and terms.
 *
 * A named scope may not take one of them, or a rule could no longer say which
 * it meant.
 */
export const RESERVED_SCOPES = new Set([
	"alt",
	"blockquote",
	"caption",
	"cell",
	"class",
	"code",
	"comment",
	"doc",
	"emphasis",
	"figure",
	"header",
	"heading",
	"in",
	"link",
	"list",
	"meta",
	"paragraph",
	"raw",
	"sentence",
	"strong",
	"summary",
	"table",
	"text",
	"quote",
]);

const SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** What `loadScopeFile` writes into. */
export interface ScopeHolder {
	scopes: Record<string, string>;
}

/** Reads one `config/scopes` file into `holder`. */
export function loadScopeFile(holder: ScopeHolder, path: string): void {
	let body: string;
	try {
		body = readFileSync(path, "utf8");
	} catch (err) {
		throw newE201FromPosition(
			err instanceof Error ? err.message : String(err),
			path,
			1,
		);
	}

	let defined: unknown;
	try {
		defined = parseYAML(body);
	} catch (err) {
		throw newE201FromPosition(
			`a mapping of names to scopes: ${err instanceof Error ? err.message : String(err)}`,
			path,
			1,
		);
	}

	if (defined === null || defined === undefined) return;
	if (typeof defined !== "object" || Array.isArray(defined)) {
		throw newE201FromPosition("a mapping of names to scopes", path, 1);
	}

	for (const [name, raw] of Object.entries(defined as Record<string, unknown>)) {
		const scope = typeof raw === "string" ? raw : "";
		if (!SCOPE_NAME.test(name)) {
			throw newE201FromTarget(
				`'${name}' is not a scope name: letters, digits, '_' and '-' only`,
				name,
				path,
			);
		}
		if (RESERVED_SCOPES.has(name)) {
			throw newE201FromTarget(`'${name}' is a scope Vale defines`, name, path);
		}
		if (scope.trim() === "") {
			throw newE201FromTarget("a named scope needs a scope", name, path);
		}

		const seen = holder.scopes[name];
		if (seen !== undefined && seen !== scope) {
			throw newE201FromTarget(
				`'${name}' is already defined as '${seen}'`,
				name,
				path,
			);
		}
		holder.scopes[name] = scope.trim();
	}
}
