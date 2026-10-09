/**
 * The values a Tengo program computes, and the boundary between them and plain
 * JavaScript.
 *
 * Tengo separates int from float, and that separation decides what `/` means:
 * `3 / 2` is `1`, `3.0 / 2` is `1.5`. Every readability formula Vale ships
 * depends on it. JavaScript has one number type, so each value carries its
 * Tengo type in a `kind` tag and the two stay apart for as long as the program
 * runs; only `toJS` collapses them.
 *
 * # One offset unit
 *
 * Tengo is a Go program, so `len(s)` counts bytes, `s[i]` counts runes and
 * `s[i:j]` counts bytes again. This port has a single unit for all three -- the
 * JavaScript string index -- which is the same choice `@vale-ts/regex` makes
 * for match offsets. Every unit agrees on ASCII, which is what a script rule's
 * index arithmetic is written against, and keeping one unit is what lets the
 * `begin` a script computed slice the block the script was handed.
 *
 * # Int width
 *
 * An int is a JavaScript `number` held to an integral value, not a `bigint`:
 * the contract with the rest of the port is that an int crosses the boundary as
 * a `number`, and a tree-walking interpreter that boxed every int would pay for
 * it on every loop. Division truncates and `%` keeps the sign of the dividend,
 * as in Go, and the bitwise operators go through `BigInt.asIntN` so they wrap
 * at 64 bits. Magnitudes above 2^53 lose precision, which Tengo's own int does
 * not; no Vale rule reaches them.
 */

/** Raised by anything this package cannot do, at compile time or at run time. */
export class TengoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TengoError";
	}
}

/**
 * Raised by something a running program did.
 *
 * Tengo prefixes these, and Vale shows the message as it is -- a style author
 * sees `Zero.Boom: Runtime Error: not callable: int` -- so the prefix is part
 * of the output rather than decoration. A compile-time failure keeps the bare
 * `TengoError`, as Tengo's parse errors do.
 */
export class TengoRuntimeError extends TengoError {
	/** The message without the prefix. */
	readonly detail: string;

	constructor(detail: string) {
		super(`Runtime Error: ${detail}`);
		this.name = "TengoRuntimeError";
		this.detail = detail;
	}
}

/**
 * Raised when a program outlives its deadline.
 *
 * A rule that loops without a way out would otherwise stop the caller with no
 * output and no error, which reads as the tool having crashed rather than as
 * one rule needing attention.
 */
export class TengoTimeout extends TengoError {
	constructor(message: string) {
		super(message);
		this.name = "TengoTimeout";
	}
}

export interface IntValue {
	readonly kind: "int";
	readonly value: number;
}

export interface FloatValue {
	readonly kind: "float";
	readonly value: number;
}

export interface BoolValue {
	readonly kind: "bool";
	readonly value: boolean;
}

export interface StringValue {
	readonly kind: "string";
	readonly value: string;
}

/** A single code point, Go's `rune`. */
export interface CharValue {
	readonly kind: "char";
	readonly value: number;
}

export interface BytesValue {
	readonly kind: "bytes";
	value: Uint8Array;
}

export interface ArrayValue {
	readonly kind: "array";
	readonly immutable: boolean;
	value: Value[];
}

/**
 * A map with string keys.
 *
 * A `Map` rather than an object, so that iteration order is insertion order
 * rather than whatever a plain object would do with numeric-looking keys. Go's
 * map order is unspecified, so insertion order is both legal and kinder to a
 * rule author reading `fmt.println(m)`.
 */
export interface MapValue {
	readonly kind: "map";
	readonly immutable: boolean;
	readonly value: Map<string, Value>;
}

export interface UndefinedValue {
	readonly kind: "undefined";
}

export interface ErrorValue {
	readonly kind: "error";
	readonly value: Value;
}

/** A point in time, as epoch milliseconds. */
export interface TimeValue {
	readonly kind: "time";
	readonly value: number;
}

export interface FuncValue {
	readonly kind: "func";
	readonly name: string;
	/**
	 * Whether this came from a `func` literal rather than from the host.
	 *
	 * `is_function` is false for a builtin and true for a literal, while
	 * `is_callable` is true for both; this is the bit that tells them apart.
	 */
	readonly literal: boolean;
	readonly call: (args: Value[]) => Value;
}

export type Value =
	| IntValue
	| FloatValue
	| BoolValue
	| StringValue
	| CharValue
	| BytesValue
	| ArrayValue
	| MapValue
	| UndefinedValue
	| ErrorValue
	| TimeValue
	| FuncValue;

export const UNDEFINED: UndefinedValue = { kind: "undefined" };
export const TRUE: BoolValue = { kind: "bool", value: true };
export const FALSE: BoolValue = { kind: "bool", value: false };

export function makeInt(value: number): IntValue {
	return { kind: "int", value };
}

export function makeFloat(value: number): FloatValue {
	return { kind: "float", value };
}

export function makeBool(value: boolean): BoolValue {
	return value ? TRUE : FALSE;
}

export function makeString(value: string): StringValue {
	return { kind: "string", value };
}

export function makeChar(value: number): CharValue {
	return { kind: "char", value };
}

export function makeBytes(value: Uint8Array): BytesValue {
	return { kind: "bytes", value };
}

export function makeArray(value: Value[], immutable = false): ArrayValue {
	return { kind: "array", immutable, value };
}

export function makeMap(value: Map<string, Value>, immutable = false): MapValue {
	return { kind: "map", immutable, value };
}

export function makeError(value: Value): ErrorValue {
	return { kind: "error", value };
}

export function makeTime(value: number): TimeValue {
	return { kind: "time", value };
}

/** A host function, which `is_function` reports false for. */
export function makeBuiltin(
	name: string,
	call: (args: Value[]) => Value,
): FuncValue {
	return { kind: "func", name, literal: false, call };
}

/** The name `type_name` gives a value. */
export function typeName(v: Value): string {
	switch (v.kind) {
		case "array":
			return v.immutable ? "immutable-array" : "array";
		case "map":
			return v.immutable ? "immutable-map" : "map";
		case "func":
			return v.literal ? "compiled-function" : `builtin-function:${v.name}`;
		default:
			return v.kind;
	}
}

/**
 * Whether a value reads as false in a condition.
 *
 * Note that a float is falsy only when it is NaN, so `0.0` is true where `0`
 * is false. That is Tengo's rule, odd as it looks, and a formula that tests a
 * count would see the difference.
 */
export function isFalsy(v: Value): boolean {
	switch (v.kind) {
		case "int":
			return v.value === 0;
		case "float":
			return Number.isNaN(v.value);
		case "bool":
			return !v.value;
		case "string":
			return v.value.length === 0;
		case "char":
			return v.value === 0;
		case "bytes":
			return v.value.length === 0;
		case "array":
			return v.value.length === 0;
		case "map":
			return v.value.size === 0;
		case "time":
			return v.value === 0;
		case "undefined":
		case "error":
			return true;
		case "func":
			return false;
	}
}

export function truthy(v: Value): boolean {
	return !isFalsy(v);
}

/**
 * Formats a float the way Go's `strconv.FormatFloat(v, 'f', -1, 64)` does:
 * the shortest decimal that reads back as the same float, never in exponent
 * form.
 *
 * `String(v)` gives the same shortest digits but switches to exponent notation
 * at both ends of the range, so those cases are expanded by hand.
 */
export function formatFloatF(v: number): string {
	if (Number.isNaN(v)) return "NaN";
	if (v === Number.POSITIVE_INFINITY) return "+Inf";
	if (v === Number.NEGATIVE_INFINITY) return "-Inf";

	const s = String(v);
	const e = s.indexOf("e");
	if (e < 0) return s;

	const exp = Number.parseInt(s.slice(e + 1), 10);
	let mantissa = s.slice(0, e);
	let sign = "";
	if (mantissa.startsWith("-")) {
		sign = "-";
		mantissa = mantissa.slice(1);
	}
	const dot = mantissa.indexOf(".");
	let digits = mantissa;
	let pointAt = mantissa.length;
	if (dot >= 0) {
		digits = mantissa.slice(0, dot) + mantissa.slice(dot + 1);
		pointAt = dot;
	}
	pointAt += exp;

	if (pointAt <= 0) return `${sign}0.${"0".repeat(-pointAt)}${digits}`;
	if (pointAt >= digits.length) {
		return sign + digits + "0".repeat(pointAt - digits.length);
	}
	return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

/** The shortest digits of `v` and its decimal exponent, for `%g` and `%e`. */
export function shortestDigits(v: number): { digits: string; exp: number } {
	// toExponential() without an argument gives "as many digits as necessary",
	// which is the shortest round-tripping form.
	const s = Math.abs(v).toExponential();
	const e = s.indexOf("e");
	const mantissa = s.slice(0, e);
	const exp = Number.parseInt(s.slice(e + 1), 10);
	return { digits: mantissa.replace(".", ""), exp };
}

/**
 * Formats a float the way Go's `%g` does with the shortest precision: `%e`
 * when the decimal exponent is below -4 or at least 6, `%f` otherwise.
 */
export function formatFloatG(v: number): string {
	if (Number.isNaN(v)) return "NaN";
	if (v === Number.POSITIVE_INFINITY) return "+Inf";
	if (v === Number.NEGATIVE_INFINITY) return "-Inf";
	if (v === 0) return Object.is(v, -0) ? "-0" : "0";

	const { exp } = shortestDigits(v);
	if (exp < -4 || exp >= 6) {
		const { digits } = shortestDigits(v);
		const sign = v < 0 ? "-" : "";
		const head = digits[0] ?? "0";
		const tail = digits.slice(1);
		const body = tail.length > 0 ? `${head}.${tail}` : head;
		const esign = exp < 0 ? "-" : "+";
		const mag = Math.abs(exp).toString().padStart(2, "0");
		return `${sign}${body}e${esign}${mag}`;
	}
	return formatFloatF(v);
}

/** The text a code point stands for, surrogate pairs included. */
export function charText(code: number): string {
	if (code < 0 || code > 0x10ffff) return "�";
	return String.fromCodePoint(code);
}

/**
 * The rendering `Object.String()` gives a value -- what `fmt.println` prints
 * and what `string(x)` falls back to.
 *
 * Note that a string renders itself quoted here, which is why `string(x)` has
 * to special-case it rather than call through.
 */
export function display(v: Value): string {
	switch (v.kind) {
		case "int":
			return String(v.value);
		case "float":
			return formatFloatF(v.value);
		case "bool":
			return v.value ? "true" : "false";
		case "string":
			return quoteGo(v.value);
		case "char":
			return charText(v.value);
		case "bytes":
			return new TextDecoder().decode(v.value);
		case "array":
			return `[${v.value.map(display).join(", ")}]`;
		case "map": {
			const pairs: string[] = [];
			for (const [k, item] of v.value) pairs.push(`${k}: ${display(item)}`);
			return `{${pairs.join(", ")}}`;
		}
		case "undefined":
			return "<undefined>";
		case "error":
			return `error: ${display(v.value)}`;
		case "time": {
			// Go's `Time.String()`; everything here is built from a Unix
			// timestamp, so the zone is always UTC.
			const iso = new Date(v.value).toISOString();
			return `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000 UTC`;
		}
		case "func":
			return v.literal ? "<compiled-function>" : `<${typeName(v)}>`;
	}
}

const GO_ESCAPES = new Map<string, string>([
	["\x07", "\\a"],
	["\b", "\\b"],
	["\f", "\\f"],
	["\n", "\\n"],
	["\r", "\\r"],
	["\t", "\\t"],
	["\v", "\\v"],
	["\\", "\\\\"],
	['"', '\\"'],
]);

/** `strconv.Quote`: a double-quoted Go string literal for `s`. */
export function quoteGo(s: string): string {
	let out = '"';
	for (const ch of s) {
		const esc = GO_ESCAPES.get(ch);
		if (esc !== undefined) {
			out += esc;
			continue;
		}
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) {
			out += `\\x${code.toString(16).padStart(2, "0")}`;
		} else {
			out += ch;
		}
	}
	return `${out}"`;
}

/** `ToString`: the text of a value, or null for undefined. */
export function toStringValue(v: Value): string | null {
	if (v.kind === "undefined") return null;
	if (v.kind === "string") return v.value;
	return display(v);
}

/** `ToInt64`: the integral value of `v`, or null when there is none. */
export function toIntValue(v: Value): number | null {
	switch (v.kind) {
		case "int":
			return v.value;
		case "float":
			return Number.isFinite(v.value) ? Math.trunc(v.value) : 0;
		case "char":
			return v.value;
		case "bool":
			return v.value ? 1 : 0;
		case "string": {
			// Go's ParseInt, base 10: no sign-less whitespace, no exponent.
			if (!/^[+-]?\d+$/.test(v.value)) return null;
			return Number.parseInt(v.value, 10);
		}
		default:
			return null;
	}
}

/** `ToFloat64`: the floating-point value of `v`, or null when there is none. */
export function toFloatValue(v: Value): number | null {
	switch (v.kind) {
		case "int":
			return v.value;
		case "float":
			return v.value;
		case "string": {
			const n = parseGoFloat(v.value);
			return n;
		}
		default:
			return null;
	}
}

/** Go's `strconv.ParseFloat`, which is stricter than `Number()`. */
export function parseGoFloat(s: string): number | null {
	if (s.length === 0) return null;
	if (/^[+-]?(inf|infinity)$/i.test(s)) {
		return s.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
	}
	if (/^[+-]?nan$/i.test(s)) return Number.NaN;
	if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
		if (!/^[+-]?0[xX][0-9a-fA-F.]+([pP][+-]?\d+)?$/.test(s)) return null;
	}
	const n = Number(s);
	return Number.isNaN(n) ? null : n;
}

/** `ToRune`: the code point of `v`, or null when there is none. */
export function toCharValue(v: Value): number | null {
	if (v.kind === "int") return v.value;
	if (v.kind === "char") return v.value;
	return null;
}

/** `ToByteSlice`: the bytes of `v`, or null when there are none. */
export function toBytesValue(v: Value): Uint8Array | null {
	if (v.kind === "bytes") return v.value;
	if (v.kind === "string") return new TextEncoder().encode(v.value);
	return null;
}

/** Whether two values are equal, as `==` reports it. */
export function equals(a: Value, b: Value): boolean {
	if (a.kind === "int" && b.kind === "float") return a.value === b.value;
	if (a.kind === "float" && b.kind === "int") return a.value === b.value;
	if (a.kind === "int" && b.kind === "char") return a.value === b.value;
	if (a.kind === "char" && b.kind === "int") return a.value === b.value;

	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case "int":
		case "float":
		case "bool":
		case "string":
		case "char":
		case "time":
			return a.value === (b as typeof a).value;
		case "bytes": {
			const other = (b as BytesValue).value;
			if (a.value.length !== other.length) return false;
			for (let i = 0; i < a.value.length; i++) {
				if (a.value[i] !== other[i]) return false;
			}
			return true;
		}
		case "array": {
			const other = (b as ArrayValue).value;
			if (a.value.length !== other.length) return false;
			for (let i = 0; i < a.value.length; i++) {
				if (!equals(a.value[i]!, other[i]!)) return false;
			}
			return true;
		}
		case "map": {
			const other = (b as MapValue).value;
			if (a.value.size !== other.size) return false;
			for (const [k, item] of a.value) {
				const against = other.get(k);
				if (against === undefined || !equals(item, against)) return false;
			}
			return true;
		}
		case "error":
			return equals(a.value, (b as ErrorValue).value);
		case "undefined":
			return true;
		case "func":
			return a === b;
	}
}

/**
 * `copy`: a deep copy of `v`, mutable even where the original was not.
 *
 * Tengo's `Copy` is deep for arrays and maps and a plain value for everything
 * else, and dropping immutability is deliberate -- it is how a program takes a
 * writable version of an exported value.
 */
export function copyValue(v: Value): Value {
	switch (v.kind) {
		case "array":
			return makeArray(v.value.map(copyValue));
		case "map": {
			const out = new Map<string, Value>();
			for (const [k, item] of v.value) out.set(k, copyValue(item));
			return makeMap(out);
		}
		case "bytes":
			return makeBytes(new Uint8Array(v.value));
		case "error":
			return makeError(copyValue(v.value));
		default:
			return v;
	}
}

/** `immutable(x)`: the same container, marked read-only. */
export function freezeShallow(v: Value): Value {
	if (v.kind === "array") return makeArray(v.value, true);
	if (v.kind === "map") return makeMap(v.value, true);
	return v;
}

/** `freeze(x)`: `v` with every container in it read-only. */
export function freezeDeep(v: Value): Value {
	switch (v.kind) {
		case "array": {
			const items = v.value.map(freezeDeep);
			return makeArray(items, true);
		}
		case "map": {
			const out = new Map<string, Value>();
			for (const [k, item] of v.value) out.set(k, freezeDeep(item));
			return makeMap(out, true);
		}
		default:
			return v;
	}
}

/**
 * A Tengo value as a plain JavaScript one.
 *
 * Both int and float become `number`; an int is always integral, which is what
 * a caller reading a script's `{begin, end}` map needs. A function becomes a
 * JavaScript function that converts in both directions, so a caller can keep
 * calling back into the program after it has run.
 */
export function toJS(v: Value): unknown {
	switch (v.kind) {
		case "int":
		case "float":
		case "char":
			return v.value;
		case "bool":
		case "string":
			return v.value;
		case "bytes":
			return v.value;
		case "array":
			return v.value.map(toJS);
		case "map": {
			const out: Record<string, unknown> = {};
			for (const [k, item] of v.value) out[k] = toJS(item);
			return out;
		}
		case "undefined":
			return undefined;
		case "error":
			return new Error(display(v.value));
		case "time":
			return new Date(v.value);
		case "func":
			return (...args: unknown[]) => toJS(v.call(args.map(fromJS)));
	}
}

/**
 * A plain JavaScript value as a Tengo one.
 *
 * A `number` becomes a **float**, never an int. Go's `Script.Add` reads the
 * static type -- `int` or `float64` -- and JavaScript has only the one, so the
 * choice has to be fixed; float is the one every metric formula needs, since
 * `characters / words` under an int would truncate. Pass a `bigint` where an
 * int is wanted.
 */
export function fromJS(x: unknown): Value {
	if (x === undefined || x === null) return UNDEFINED;
	switch (typeof x) {
		case "boolean":
			return makeBool(x);
		case "number":
			return makeFloat(x);
		case "bigint":
			return makeInt(Number(x));
		case "string":
			return makeString(x);
		case "function":
			return makeBuiltin("js", (args) => {
				const out = (x as (...a: unknown[]) => unknown)(...args.map(toJS));
				return fromJS(out);
			});
	}
	if (x instanceof Uint8Array) return makeBytes(x);
	if (x instanceof Date) return makeTime(x.getTime());
	if (x instanceof Error) return makeError(makeString(x.message));
	if (Array.isArray(x)) return makeArray(x.map(fromJS));
	if (typeof x === "object") {
		const out = new Map<string, Value>();
		for (const [k, item] of Object.entries(x as Record<string, unknown>)) {
			out.set(k, fromJS(item));
		}
		return makeMap(out);
	}
	return UNDEFINED;
}

// --- argument checking ----------------------------------------------------

/**
 * The wording Tengo's own errors use, so that a style author who has seen a
 * message from the Go implementation sees the same one here.
 */
export function wrongArgs(): TengoError {
	return new TengoError("wrong number of arguments");
}

export function argTypeError(
	name: string,
	expected: string,
	found: Value,
): TengoError {
	return new TengoError(
		`invalid type for argument '${name}': expected ${expected}, found ${typeName(found)}`,
	);
}

/** Ordinal names for argument positions, as Tengo spells them. */
const ORDINALS = [
	"first",
	"second",
	"third",
	"fourth",
	"fifth",
	"sixth",
	"seventh",
	"eighth",
];

export function ordinal(i: number): string {
	return ORDINALS[i] ?? `#${i + 1}`;
}

/** The text of argument `i`, converted as `ToString` would. */
export function argString(args: Value[], i: number): string {
	const v = args[i];
	if (v === undefined) throw wrongArgs();
	const s = toStringValue(v);
	if (s === null) throw argTypeError(ordinal(i), "string(compatible)", v);
	return s;
}

/** The integral value of argument `i`, converted as `ToInt64` would. */
export function argInt(args: Value[], i: number): number {
	const v = args[i];
	if (v === undefined) throw wrongArgs();
	const n = toIntValue(v);
	if (n === null) throw argTypeError(ordinal(i), "int(compatible)", v);
	return n;
}

/** The floating-point value of argument `i`, converted as `ToFloat64` would. */
export function argFloat(args: Value[], i: number): number {
	const v = args[i];
	if (v === undefined) throw wrongArgs();
	const n = toFloatValue(v);
	if (n === null) throw argTypeError(ordinal(i), "float(compatible)", v);
	return n;
}

/** Argument `i`, which must be an int and nothing convertible to one. */
export function argStrictInt(args: Value[], i: number): number {
	const v = args[i];
	if (v === undefined) throw wrongArgs();
	if (v.kind !== "int") throw argTypeError(ordinal(i), "int", v);
	return v.value;
}

export function argArray(args: Value[], i: number): ArrayValue {
	const v = args[i];
	if (v === undefined) throw wrongArgs();
	if (v.kind !== "array") throw argTypeError(ordinal(i), "array", v);
	return v;
}

export function argMap(args: Value[], i: number): MapValue {
	const v = args[i];
	if (v === undefined) throw wrongArgs();
	if (v.kind !== "map") throw argTypeError(ordinal(i), "map", v);
	return v;
}

export function argValue(args: Value[], i: number): Value {
	const v = args[i];
	if (v === undefined) throw wrongArgs();
	return v;
}
