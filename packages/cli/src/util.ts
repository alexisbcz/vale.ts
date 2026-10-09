/**
 * The odds and ends the commands share: pluralization, and JSON written the
 * way Go writes it.
 *
 * # Why JSON is not `JSON.stringify`
 *
 * `--output=JSON`, `ls-metrics`, `ls-dirs` and `fix` are read by editor
 * plugins and CI scripts, so their bytes are part of the interface. Go's
 * `encoding/json` sorts a map's keys and escapes `<`, `>` and `&`; JavaScript
 * keeps insertion order and escapes neither. `goJSON` does what Go does, which
 * is the only reason it exists.
 */

import { ValeError } from "@vale-ts/core";
import { println } from "./out.ts";

/** Adds an `s` unless there is exactly one of something. */
export function pluralize(s: string, n: number): string {
	return n === 1 ? s : `${s}s`;
}

/**
 * A value marked as a Go map, whose keys are sorted when it is written.
 *
 * A struct keeps the order its fields were declared in, and a map is sorted;
 * both are objects here, so the two are told apart by this wrapper.
 */
class GoMap {
	constructor(readonly value: Record<string, unknown>) {}
}

/** Marks a record as a Go map, so `goJSON` sorts its keys. */
export function asMap(value: Record<string, unknown>): unknown {
	return new GoMap(value);
}

/**
 * `encoding/json`'s string escaping.
 *
 * Go escapes the three characters that would end an HTML context, so that a
 * message carrying a tag can be embedded in a page without a second pass.
 */
function quote(s: string): string {
	let out = '"';
	for (const ch of s) {
		switch (ch) {
			case '"':
				out += '\\"';
				break;
			case "\\":
				out += "\\\\";
				break;
			case "\n":
				out += "\\n";
				break;
			case "\r":
				out += "\\r";
				break;
			case "\t":
				out += "\\t";
				break;
			case "<":
				out += "\\u003c";
				break;
			case ">":
				out += "\\u003e";
				break;
			case "&":
				out += "\\u0026";
				break;
			default: {
				const cp = ch.codePointAt(0) ?? 0;
				if (cp < 0x20) {
					out += `\\u${cp.toString(16).padStart(4, "0")}`;
				} else {
					out += ch;
				}
			}
		}
	}
	return `${out}"`;
}

/** A number, as Go's `encoding/json` writes a `float64` or an `int`. */
function number(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (Number.isInteger(n)) return String(n);
	return String(n);
}

/**
 * `json.MarshalIndent(v, "", indent)`.
 *
 * A `GoMap`'s keys are sorted, a plain object's are kept as written, an empty
 * array is `[]` and `undefined` is `null` -- which is what a nil slice and a
 * nil map marshal to.
 */
export function goJSON(value: unknown, indent: string): string {
	return write(value, indent, "");
}

function write(value: unknown, indent: string, prefix: string): string {
	if (value === null || value === undefined) return "null";

	if (typeof value === "string") return quote(value);
	if (typeof value === "number") return number(value);
	if (typeof value === "boolean") return value ? "true" : "false";

	const inner = prefix + indent;

	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const items = value.map((v) => inner + write(v, indent, inner));
		return `[\n${items.join(",\n")}\n${prefix}]`;
	}

	if (value instanceof GoMap) {
		const keys = Object.keys(value.value).sort();
		return object(
			keys.map((k) => [k, value.value[k]] as const),
			indent,
			prefix,
			inner,
		);
	}

	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return object(Object.entries(record), indent, prefix, inner);
	}

	return "null";
}

function object(
	entries: readonly (readonly [string, unknown])[],
	indent: string,
	prefix: string,
	inner: string,
): string {
	if (entries.length === 0) return "{}";
	const items = entries.map(
		([k, v]) => `${inner}${quote(k)}: ${write(v, indent, inner)}`,
	);
	return `{\n${items.join(",\n")}\n${prefix}}`;
}

/** `getJSON`: two-space JSON, used by the formats a run prints inline. */
export function getJSON(value: unknown): string {
	return goJSON(value, "  ");
}

/** `printJSON`: four-space JSON on its own line, used by the commands. */
export function printJSON(value: unknown): void {
	println(goJSON(value, "    "));
}

/** What `install` and the native host commands answer with. */
export interface Response {
	Msg: string;
	Error: string;
	Success: boolean;
}

/** Reports the outcome of a local action as JSON. */
export function sendResponse(msg: string, err: unknown): void {
	const resp: Response = { Msg: msg, Error: "", Success: err === null };
	if (!resp.Success) resp.Error = messageOf(err);
	printJSON(resp);
}

/** An error's message, whatever shape it arrived in. */
export function messageOf(err: unknown): string {
	if (err instanceof ValeError) return err.msg;
	if (err instanceof Error) return err.message;
	return String(err);
}

/** Fetches a URL and returns its body as text. */
export async function fetchJSON(url: string): Promise<string> {
	const resp = await fetch(url);
	return resp.text();
}
