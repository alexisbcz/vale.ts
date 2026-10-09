/**
 * The functions a `--output=<template>` template may call.
 *
 * Two groups: the ones Vale defines itself -- colors, and the borderless table
 * its own `cli.tmpl` builds -- and the slice of Sprig that its templates reach
 * for. Sprig is a large library and Vale's templates use fourteen of it, so
 * those fourteen are here rather than the library.
 *
 * `renderTable` writes straight to stdout, as it does in Go, which is why the
 * template engine emits through the same sink: a table has to land between the
 * lines of text around it.
 */

import { println, stdout } from "./out.ts";
import {
	blue as blueStyle,
	red as redStyle,
	renderBorderless,
	underline as underlineStyle,
	yellow as yellowStyle,
} from "./term.ts";
import { sprintf, stringify, type TemplateFunc, truthy } from "./template.ts";
import { getJSON } from "./util.ts";

/** A table a template is filling in, row by row. */
class TemplateTable {
	readonly rows: string[][] = [];
}

/** A value as a string, the way Sprig's string functions coerce. */
function text(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	return stringify(value);
}

/** A value as a number, the way Sprig's `int` coerces. */
function num(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	const parsed = Number.parseFloat(text(value));
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** A value as a list, so `join` and friends accept one or many. */
function list(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (value === undefined || value === null) return [];
	return [value];
}

/** Sprig's dictionaries are mutable and shared, so they are real maps. */
function asDict(value: unknown): Map<string, unknown> {
	if (value instanceof Map) return value as Map<string, unknown>;
	const out = new Map<string, unknown>();
	if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out.set(k, v);
		}
	}
	return out;
}

export const FUNCS: Record<string, TemplateFunc> = {
	// --- Vale's own ---------------------------------------------------------

	red: (s) => redStyle(text(s)),
	blue: (s) => blueStyle(text(s)),
	yellow: (s) => yellowStyle(text(s)),
	underline: (s) => underlineStyle(text(s)),

	newTable: () => new TemplateTable(),

	addRow: (table, row) => {
		if (table instanceof TemplateTable) {
			table.rows.push(list(row).map(text));
		}
		return table;
	},

	renderTable: (table) => {
		if (table instanceof TemplateTable) {
			println();
			stdout(renderBorderless(table.rows));
			println();
			table.rows.length = 0;
		}
		return table;
	},

	jsonEscape: (s) => {
		const quoted = getJSON(text(s));
		return quoted.slice(1, -1);
	},

	// --- arithmetic --------------------------------------------------------

	add: (...args) => args.reduce((sum, a) => num(sum) + num(a), 0),
	add1: (a) => num(a) + 1,
	sub: (a, b) => num(a) - num(b),
	mul: (...args) => args.reduce((p, a) => num(p) * num(a), 1),
	div: (a, b) => Math.trunc(num(a) / num(b)),
	mod: (a, b) => num(a) % num(b),
	max: (...args) => Math.max(...args.map(num)),
	min: (...args) => Math.min(...args.map(num)),
	int: (a) => Math.trunc(num(a)),
	int64: (a) => Math.trunc(num(a)),
	float64: (a) => num(a),
	round: (a, places) => {
		const factor = 10 ** Math.trunc(num(places));
		return Math.round(num(a) * factor) / factor;
	},

	// --- strings -----------------------------------------------------------

	upper: (s) => text(s).toUpperCase(),
	lower: (s) => text(s).toLowerCase(),
	title: (s) => text(s).replace(/\b\w/g, (c) => c.toUpperCase()),
	trim: (s) => text(s).trim(),
	trimAll: (cut, s) => {
		const set = new Set([...text(cut)]);
		let out = text(s);
		while (out.length > 0 && set.has(out[0] as string)) out = out.slice(1);
		while (out.length > 0 && set.has(out[out.length - 1] as string)) {
			out = out.slice(0, -1);
		}
		return out;
	},
	trimPrefix: (prefix, s) => {
		const value = text(s);
		const cut = text(prefix);
		return cut !== "" && value.startsWith(cut) ? value.slice(cut.length) : value;
	},
	trimSuffix: (suffix, s) => {
		const value = text(s);
		const cut = text(suffix);
		return cut !== "" && value.endsWith(cut)
			? value.slice(0, -cut.length)
			: value;
	},
	replace: (old, next, s) =>
		text(s).split(text(old)).join(text(next)),
	repeat: (n, s) => text(s).repeat(Math.max(0, Math.trunc(num(n)))),
	contains: (needle, s) => text(s).includes(text(needle)),
	hasPrefix: (prefix, s) => text(s).startsWith(text(prefix)),
	hasSuffix: (suffix, s) => text(s).endsWith(text(suffix)),
	quote: (...args) => args.map((a) => `"${text(a)}"`).join(" "),
	squote: (...args) => args.map((a) => `'${text(a)}'`).join(" "),
	indent: (spaces, s) => {
		const pad = " ".repeat(Math.max(0, Math.trunc(num(spaces))));
		return text(s)
			.split("\n")
			.map((line) => pad + line)
			.join("\n");
	},
	nindent: (spaces, s) => {
		const pad = " ".repeat(Math.max(0, Math.trunc(num(spaces))));
		return `\n${text(s)
			.split("\n")
			.map((line) => pad + line)
			.join("\n")}`;
	},
	/**
	 * `cat` joins what it is given with a space, dropping nils -- which is what
	 * lets a template accumulate into a key that may not be set yet.
	 */
	cat: (...args) =>
		args
			.filter((a) => a !== null && a !== undefined)
			.map(text)
			.join(" ")
			.trim(),
	plural: (one, many, count) => (num(count) === 1 ? text(one) : text(many)),
	printf: (format, ...args) => sprintf(text(format), args),
	toString: (a) => text(a),
	toJson: (a) => getJSON(a),

	// --- lists -------------------------------------------------------------

	list: (...args) => args,
	toStrings: (value) => list(value).map(text),
	first: (value) => list(value)[0],
	last: (value) => {
		const items = list(value);
		return items[items.length - 1];
	},
	rest: (value) => list(value).slice(1),
	initial: (value) => list(value).slice(0, -1),
	reverse: (value) => [...list(value)].reverse(),
	uniq: (value) => [...new Set(list(value))],
	compact: (value) => list(value).filter(truthy),
	join: (sep, value) => list(value).map(text).join(text(sep)),
	split: (sep, s) => {
		const parts = text(s).split(text(sep));
		const out = new Map<string, unknown>();
		parts.forEach((p, i) => out.set(`_${i}`, p));
		return out;
	},
	splitList: (sep, s) => text(s).split(text(sep)),

	// --- dictionaries ------------------------------------------------------

	dict: (...args) => {
		const out = new Map<string, unknown>();
		for (let i = 0; i < args.length; i += 2) {
			out.set(text(args[i]), args[i + 1] ?? "");
		}
		return out;
	},
	get: (dict, key) => asDict(dict).get(text(key)) ?? "",
	set: (dict, key, value) => {
		const map = asDict(dict);
		map.set(text(key), value);
		return map;
	},
	unset: (dict, key) => {
		const map = asDict(dict);
		map.delete(text(key));
		return map;
	},
	hasKey: (dict, key) => asDict(dict).has(text(key)),
	keys: (...dicts) => {
		const names = new Set<string>();
		for (const d of dicts) for (const k of asDict(d).keys()) names.add(k);
		return [...names].sort();
	},
	values: (dict) => [...asDict(dict).values()],

	// --- misc --------------------------------------------------------------

	empty: (a) => !truthy(a),
	default: (fallback, value) => (truthy(value) ? value : fallback),
	coalesce: (...args) => args.find(truthy) ?? null,
};
