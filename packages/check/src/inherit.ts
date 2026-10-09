/**
 * `extends: <another rule>`: starting from another rule's definition.
 *
 * An `extends` value containing a dot is a rule reference, resolved against
 * the styles on the search path. The child starts from the parent's definition
 * and lays its own keys on top, so two styles can share one carefully built
 * pattern and disagree only about message, level, or a handful of entries.
 *
 * Overlay semantics, chosen once and used everywhere:
 *
 *  - A bare key replaces the parent's value wholesale.
 *  - `key+` appends to a parent list, or merges into a parent map with the
 *    child's entries winning.
 *  - `key-` removes entries from a parent list by their source text, or the
 *    named keys from a parent map. Removing something the parent does not have
 *    is an error: if upstream renames or drops an entry a child was removing,
 *    the child's author hears about it at compile time instead of silently
 *    diverging.
 *  - A scalar takes only the bare form, and a file that writes both `key` and
 *    `key+`/`key-` has said "replace" and "edit the replacement" at once,
 *    which is always a mistake.
 *
 * The parent must be present on the search path, not enabled: inheritance is a
 * file reference, and `vale sync` is what puts the file there.
 */

import { readFileSync } from "node:fs";
import {
	type Config,
	fileExists,
	joinPath,
	newE201FromPosition,
} from "@vale-ts/core";
import type { BaseCheck } from "./decode.ts";
import { isRuleRef, parseDefinition } from "./definition.ts";
import { trimRightCutset } from "./util.ts";

/**
 * How deep a chain of rule references may run.
 *
 * Deeper nesting is nearly always a cycle routed through distinct files.
 */
const MAX_INHERITANCE_DEPTH = 10;

/**
 * Resolves a rule's inheritance chain, returning the definition `buildRule`
 * should see: the root ancestor's extension point with every descendant's keys
 * overlaid in order.
 */
export function flatten(
	cfg: Config,
	generic: BaseCheck,
	path: string,
	seen: readonly string[],
): BaseCheck {
	const extendsValue = generic.extends;
	if (typeof extendsValue !== "string" || !isRuleRef(extendsValue)) {
		// A base rule has no parent for `+`/`-` to act on.
		for (const key of Object.keys(generic)) {
			if (key === "") continue;
			const op = key[key.length - 1];
			if (op === "+" || op === "-") {
				throw newE201FromPosition(
					`'${key}' needs a parent: only a rule that extends another rule can use '+' or '-'`,
					path,
					1,
				);
			}
		}
		return generic;
	}

	if (extendsValue.startsWith("Vale.")) {
		throw newE201FromPosition(
			`'${extendsValue}' is a built-in rule generated at runtime; it has no file to extend`,
			path,
			1,
		);
	}

	if (seen.length >= MAX_INHERITANCE_DEPTH) {
		throw newE201FromPosition(
			`inheritance chain is over ${MAX_INHERITANCE_DEPTH} rules deep at '${extendsValue}'; is there a cycle?`,
			path,
			1,
		);
	}
	for (const name of seen) {
		if (name === extendsValue) {
			throw newE201FromPosition(
				`inheritance cycle: '${extendsValue}' is already in this chain`,
				path,
				1,
			);
		}
	}

	let parentPath: string;
	try {
		parentPath = resolveRule(cfg, extendsValue);
	} catch (err) {
		throw newE201FromPosition(
			err instanceof Error ? err.message : String(err),
			path,
			1,
		);
	}

	let data: string;
	try {
		data = readFileSync(parentPath, "utf8");
	} catch (err) {
		throw newE201FromPosition(
			err instanceof Error ? err.message : String(err),
			parentPath,
			1,
		);
	}

	let parent = parseDefinition(data, parentPath);
	parent = flatten(cfg, parent, parentPath, [...seen, extendsValue]);

	// A parent's cases assert the parent's behavior; a child that changes a
	// threshold or a token list has to bring its own.
	delete parent.tests;

	return overlay(parent, generic, path);
}

/**
 * Maps a rule name to its file: the first segment is a style directory on the
 * search path, and every segment after it is a path component -- the same
 * reading loading gives names.
 */
export function resolveRule(cfg: Config, name: string): string {
	const parts = name.split(".");
	if (parts.length < 2) throw new Error(`'${name}' is not a rule name`);

	const rel = `${parts.slice(1).join("/")}.yml`;
	for (const p of cfg.searchPaths()) {
		const candidate = joinPath(p, parts[0]!, rel);
		if (fileExists(candidate)) return candidate;
	}

	throw new Error(
		`'${name}' does not exist on the search path (looked for '${joinPath(parts[0]!, rel)}')`,
	);
}

/** Lays a child's keys over its parent's definition. */
export function overlay(
	parent: BaseCheck,
	child: BaseCheck,
	path: string,
): BaseCheck {
	const out: BaseCheck = { ...parent };

	for (const [key, v] of Object.entries(child)) {
		const base = trimRightCutset(key, "+-");
		if (base !== key) {
			if (Object.hasOwn(child, base)) {
				throw newE201FromPosition(
					`'${key}' both replaces '${base}' and edits it; pick one`,
					path,
					1,
				);
			}

			try {
				out[base] = editField(out[base], v, key);
			} catch (err) {
				throw newE201FromPosition(
					err instanceof Error ? err.message : String(err),
					path,
					1,
				);
			}
			continue;
		}

		if (key === "extends") {
			// The reference is consumed here; `buildRule` sees the root
			// ancestor's extension point.
			continue;
		}
		out[key] = v;
	}

	return out;
}

/** Applies one `key+` or `key-` operation to a parent's value. */
export function editField(parent: unknown, value: unknown, key: string): unknown {
	const add = key.endsWith("+");

	if (Array.isArray(parent)) {
		if (!Array.isArray(value)) throw new Error(`'${key}' needs a list`);
		if (add) return [...parent, ...value];
		return removeEntries(parent, value, key);
	}

	if (parent !== null && typeof parent === "object") {
		const have = parent as Record<string, unknown>;
		if (add) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				throw new Error(`'${key}' needs a mapping`);
			}
			return { ...have, ...(value as Record<string, unknown>) };
		}

		if (!Array.isArray(value)) {
			throw new Error(`'${key}' needs a list of keys to remove`);
		}
		const merged = { ...have };
		for (const name of value) {
			const k = typeof name === "string" ? name : "";
			if (!Object.hasOwn(merged, k)) {
				throw new Error(
					`'${key}': the parent has no entry '${String(name)}' to remove`,
				);
			}
			delete merged[k];
		}
		return merged;
	}

	if (parent === undefined || parent === null) {
		throw new Error(`'${key}': the parent has no such field`);
	}

	throw new Error(
		`'${key}': '${trimRightCutset(key, "+-")}' is a single value; assign it directly instead`,
	);
}

function removeEntries(
	have: readonly unknown[],
	entries: readonly unknown[],
	key: string,
): unknown[] {
	const out = [...have];
	for (const entry of entries) {
		const found = out.findIndex((existing) => deepEqual(existing, entry));
		if (found < 0) {
			throw new Error(
				`'${key}': the parent has no entry '${String(entry)}' to remove`,
			);
		}
		out.splice(found, 1);
	}
	return out;
}

/** Go's `reflect.DeepEqual` over the values YAML produces. */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
	}
	if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
		const ka = Object.keys(a as object);
		const kb = Object.keys(b as object);
		if (ka.length !== kb.length) return false;
		return ka.every((k) =>
			deepEqual(
				(a as Record<string, unknown>)[k],
				(b as Record<string, unknown>)[k],
			),
		);
	}
	return false;
}
