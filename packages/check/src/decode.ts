/**
 * Reading a YAML rule definition into a rule.
 *
 * Go does this with `mapstructure`, configured `WeaklyTypedInput` (so that a
 * configuration override written as a string reaches an `int` field) and
 * `ErrorUnused` (so that a misspelled key is an error rather than silently
 * doing nothing). There is no such decoder here, so each rule reads its own
 * fields through a `Fields` and then calls `done`, which reports the first key
 * the rule did not ask for.
 *
 * `ErrorUnused` is load-bearing UX, not a detail: a rule with a key its type
 * does not know must fail to load, naming the key, because that is how a style
 * author finds a typo. The messages below are worded as `mapstructure`'s are,
 * so existing documentation and existing expectations still read true.
 */

import { type Action, emptyAction } from "@vale-ts/core";

/** A rule definition as it comes out of YAML. */
export type BaseCheck = Record<string, unknown>;

/** What went wrong reading one field. */
export class FieldError extends Error {
	/** The key at fault, as written in the file. */
	readonly key: string;

	/** `mapstructure`'s wording for this failure, without the key. */
	readonly detail: string;

	constructor(key: string, detail: string) {
		super(key === "" ? detail : `'${key}' ${detail}`);
		this.name = "FieldError";
		this.key = key;
		this.detail = detail;
	}
}

function typeError(key: string, want: string, value: unknown): FieldError {
	return new FieldError(
		key,
		`expected type '${want}', got unconvertible type '${jsType(value)}', value: '${String(value)}'`,
	);
}

function jsType(value: unknown): string {
	if (value === null) return "nil";
	if (Array.isArray(value)) return "[]interface {}";
	return typeof value;
}

/** Go's `strconv.ParseBool`. */
function parseBool(s: string): boolean | null {
	switch (s) {
		case "1":
		case "t":
		case "T":
		case "TRUE":
		case "true":
		case "True":
			return true;
		case "0":
		case "f":
		case "F":
		case "FALSE":
		case "false":
		case "False":
			return false;
		default:
			return null;
	}
}

/**
 * A rule definition being read field by field.
 *
 * Every read marks its key as known, present or not, so `done` can tell a key
 * the rule ignores from one it has never heard of.
 */
export class Fields {
	private readonly src: BaseCheck;
	private readonly known = new Set<string>();

	constructor(src: BaseCheck) {
		this.src = src;
	}

	/** The value at `key`, or undefined when it is absent or null. */
	private read(key: string): unknown {
		this.known.add(key);
		const v = this.src[key];
		return v === null ? undefined : v;
	}

	/** Marks `key` as one this rule knows, without reading it. */
	ignore(...keys: readonly string[]): void {
		for (const k of keys) this.known.add(k);
	}

	/** The raw value at `key`, for a field with its own parsing. */
	raw(key: string): unknown {
		return this.read(key);
	}

	/** Whether the definition carries `key` at all, null included. */
	has(key: string): boolean {
		return Object.hasOwn(this.src, key);
	}

	string(key: string, dflt = ""): string {
		const v = this.read(key);
		if (v === undefined) return dflt;
		const s = weakString(v);
		if (s === null) throw typeError(key, "string", v);
		return s;
	}

	bool(key: string, dflt = false): boolean {
		const v = this.read(key);
		if (v === undefined) return dflt;
		if (typeof v === "boolean") return v;
		if (typeof v === "number") return v !== 0;
		if (typeof v === "string") {
			if (v === "") return false;
			const b = parseBool(v);
			if (b === null) throw typeError(key, "bool", v);
			return b;
		}
		throw typeError(key, "bool", v);
	}

	int(key: string, dflt = 0): number {
		const v = this.read(key);
		if (v === undefined) return dflt;
		const n = weakNumber(v, key, "int");
		return Math.trunc(n);
	}

	float(key: string, dflt = 0): number {
		const v = this.read(key);
		if (v === undefined) return dflt;
		return weakNumber(v, key, "float64");
	}

	strings(key: string, dflt: readonly string[] = []): string[] {
		const v = this.read(key);
		if (v === undefined) return [...dflt];
		return liftStrings(key, v);
	}

	stringMap(
		key: string,
		dflt: Readonly<Record<string, string>> = {},
	): Record<string, string> {
		const v = this.read(key);
		if (v === undefined) return { ...dflt };
		if (v instanceof Map) {
			const out: Record<string, string> = {};
			for (const [k, raw] of v) out[String(k)] = mustString(key, raw);
			return out;
		}
		if (typeof v !== "object" || Array.isArray(v)) {
			throw typeError(key, "map[string]string", v);
		}
		const out: Record<string, string> = {};
		for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
			out[k] = mustString(key, raw);
		}
		return out;
	}

	/** A rule's `action`, as either a nested mapping or an `Action` already. */
	action(key: string): Action {
		const v = this.read(key);
		if (v === undefined) return emptyAction();
		if (typeof v !== "object" || Array.isArray(v)) {
			throw typeError(key, "core.Action", v);
		}
		const m = v as Record<string, unknown>;
		const name =
			m.name === undefined || m.name === null ? "" : mustString(key, m.name);
		const params =
			m.params === undefined || m.params === null ? [] : liftStrings(key, m.params);
		return { name, params };
	}

	/**
	 * Reports the first key the rule never asked for.
	 *
	 * Only the first, because `mapstructure` names only the first too: its
	 * message lists every unused key, and the error reader that turns that
	 * message into a position reads one word after the colon.
	 */
	done(): void {
		for (const key of Object.keys(this.src)) {
			if (!this.known.has(key)) {
				throw new FieldError(key, `has invalid keys: '${key}'`);
			}
		}
	}
}

function mustString(key: string, v: unknown): string {
	const s = weakString(v);
	if (s === null) throw typeError(key, "string", v);
	return s;
}

/** A scalar as a string, as `WeaklyTypedInput` reads one. */
function weakString(v: unknown): string | null {
	switch (typeof v) {
		case "string":
			return v;
		case "number":
			return Number.isInteger(v) ? String(v) : String(v);
		case "bigint":
			return v.toString();
		case "boolean":
			return v ? "1" : "0";
		default:
			return null;
	}
}

function weakNumber(v: unknown, key: string, want: string): number {
	if (typeof v === "number") return v;
	if (typeof v === "bigint") return Number(v);
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "string") {
		if (v.trim() === "") throw typeError(key, want, v);
		const n = Number(v);
		if (!Number.isFinite(n)) throw typeError(key, want, v);
		return n;
	}
	throw typeError(key, want, v);
}

/**
 * A value as a list of strings.
 *
 * A single value lifts into a one-element list, which is what lets `scope:
 * text` and `scope: [text]` mean the same thing.
 */
function liftStrings(key: string, v: unknown): string[] {
	if (Array.isArray(v)) {
		return v.map((item) => mustString(key, item));
	}
	// An empty mapping turns into an empty list, as `mapstructure` has it.
	if (typeof v === "object" && v !== null) {
		if (Object.keys(v as object).length === 0) return [];
		throw typeError(key, "[]string", v);
	}
	return [mustString(key, v)];
}
