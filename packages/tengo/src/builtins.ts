/**
 * The builtin functions, which a program sees without importing anything.
 *
 * Each follows Tengo's `builtins.go`, including the parts of it that the
 * documentation glosses over: a conversion returns `undefined` on failure
 * rather than raising, unless a second argument is given as the fallback; and
 * a conversion that is handed a value of the target type returns it unchanged
 * rather than rebuilding it.
 *
 * `error(x)`, `immutable(x)` and `import("m")` look like calls but are
 * expressions in the grammar, so they live in the interpreter instead.
 */

import { sprintf } from "./stdlib/fmt.ts";
import type { Value } from "./values.ts";
import {
	argArray,
	argMap,
	argStrictInt,
	argValue,
	copyValue,
	freezeDeep,
	makeArray,
	makeBool,
	makeBuiltin,
	makeBytes,
	makeChar,
	makeFloat,
	makeInt,
	makeString,
	makeTime,
	TengoError,
	toBytesValue,
	toCharValue,
	toFloatValue,
	toIntValue,
	toStringValue,
	truthy,
	typeName,
	UNDEFINED,
	wrongArgs,
} from "./values.ts";

/** Builds the builtin table; one table is shared by every program. */
function build(): Map<string, Value> {
	const table = new Map<string, Value>();

	const def = (name: string, call: (args: Value[]) => Value): void => {
		table.set(name, makeBuiltin(name, call));
	};

	def("len", (args) => {
		const v = argValue(args, 0);
		if (args.length !== 1) throw wrongArgs();
		switch (v.kind) {
			case "array":
				return makeInt(v.value.length);
			case "map":
				return makeInt(v.value.size);
			case "string":
				return makeInt(v.value.length);
			case "bytes":
				return makeInt(v.value.length);
			default:
				throw new TengoError(
					`invalid type for argument 'first': expected array/string/bytes/map, found ${typeName(v)}`,
				);
		}
	});

	def("copy", (args) => {
		if (args.length !== 1) throw wrongArgs();
		return copyValue(argValue(args, 0));
	});

	def("freeze", (args) => {
		if (args.length !== 1) throw wrongArgs();
		return freezeDeep(argValue(args, 0));
	});

	def("append", (args) => {
		if (args.length < 2) throw wrongArgs();
		const target = argValue(args, 0);
		if (target.kind !== "array") {
			throw new TengoError(
				`invalid type for argument 'first': expected array, found ${typeName(target)}`,
			);
		}
		return makeArray([...target.value, ...args.slice(1)]);
	});

	def("delete", (args) => {
		if (args.length !== 2) throw wrongArgs();
		const target = argMap(args, 0);
		const key = argValue(args, 1);
		if (key.kind !== "string") {
			throw new TengoError(
				`invalid type for argument 'second': expected string, found ${typeName(key)}`,
			);
		}
		if (target.immutable) throw new TengoError("map is immutable");
		target.value.delete(key.value);
		return UNDEFINED;
	});

	def("splice", (args) => {
		if (args.length === 0) throw wrongArgs();
		const target = argArray(args, 0);
		if (target.immutable) throw new TengoError("array is immutable");
		const length = target.value.length;

		let start = 0;
		if (args.length > 1) {
			start = argStrictInt(args, 1);
			if (start < 0 || start > length) {
				throw new TengoError("index out of bounds");
			}
		}

		let count = length;
		if (args.length > 2) {
			count = argStrictInt(args, 2);
			if (count < 0) throw new TengoError("index out of bounds");
		}
		if (start + count > length) count = length - start;

		const inserted = args.slice(3);
		const deleted = target.value.splice(start, count, ...inserted);
		return makeArray(deleted);
	});

	/**
	 * `range(start, stop, step?)`, which counts down when `start > stop`. The
	 * step is always positive; its sign comes from the bounds.
	 */
	def("range", (args) => {
		if (args.length < 2 || args.length > 3) throw wrongArgs();
		const start = argStrictInt(args, 0);
		const stop = argStrictInt(args, 1);
		const step = args.length === 3 ? argStrictInt(args, 2) : 1;
		if (step <= 0) throw new TengoError("invalid range step: must be > 0");

		const out: Value[] = [];
		if (start <= stop) {
			for (let i = start; i < stop; i += step) out.push(makeInt(i));
		} else {
			for (let i = start; i > stop; i -= step) out.push(makeInt(i));
		}
		return makeArray(out);
	});

	def("type_name", (args) => {
		if (args.length !== 1) throw wrongArgs();
		return makeString(typeName(argValue(args, 0)));
	});

	def("format", (args) => {
		if (args.length === 0) throw wrongArgs();
		const first = argValue(args, 0);
		if (first.kind !== "string") {
			throw new TengoError(
				`invalid type for argument 'format': expected string, found ${typeName(first)}`,
			);
		}
		return makeString(sprintf(first.value, args.slice(1)));
	});

	// --- conversions ------------------------------------------------------

	/**
	 * Wraps a conversion in Tengo's fallback rule: the value itself when it is
	 * already of the target kind, the conversion when it succeeds, otherwise
	 * the second argument if there is one and `undefined` if there is not.
	 */
	const conversion = (
		name: string,
		kind: Value["kind"],
		convert: (v: Value) => Value | null,
	): void => {
		def(name, (args) => {
			if (args.length !== 1 && args.length !== 2) throw wrongArgs();
			const v = argValue(args, 0);
			if (v.kind === kind) return v;
			const out = convert(v);
			if (out !== null) return out;
			return args.length === 2 ? args[1]! : UNDEFINED;
		});
	};

	conversion("string", "string", (v) => {
		const s = toStringValue(v);
		return s === null ? null : makeString(s);
	});

	conversion("int", "int", (v) => {
		const n = toIntValue(v);
		return n === null ? null : makeInt(n);
	});

	conversion("float", "float", (v) => {
		const n = toFloatValue(v);
		return n === null ? null : makeFloat(n);
	});

	conversion("char", "char", (v) => {
		const n = toCharValue(v);
		return n === null ? null : makeChar(n);
	});

	// `bool` never fails: every value is either truthy or falsy.
	def("bool", (args) => {
		if (args.length !== 1 && args.length !== 2) throw wrongArgs();
		return makeBool(truthy(argValue(args, 0)));
	});

	def("bytes", (args) => {
		if (args.length !== 1 && args.length !== 2) throw wrongArgs();
		const v = argValue(args, 0);
		// bytes(N) allocates N zero bytes rather than converting.
		if (v.kind === "int") return makeBytes(new Uint8Array(v.value));
		const b = toBytesValue(v);
		if (b !== null) return makeBytes(b);
		return args.length === 2 ? args[1]! : UNDEFINED;
	});

	def("time", (args) => {
		if (args.length !== 1 && args.length !== 2) throw wrongArgs();
		const v = argValue(args, 0);
		if (v.kind === "time") return v;
		// An int is read as Unix seconds, as `time.Unix(v, 0)` does.
		if (v.kind === "int") return makeTime(v.value * 1000);
		return args.length === 2 ? args[1]! : UNDEFINED;
	});

	// --- type tests -------------------------------------------------------

	const test = (name: string, holds: (v: Value) => boolean): void => {
		def(name, (args) => {
			if (args.length !== 1) throw wrongArgs();
			return makeBool(holds(argValue(args, 0)));
		});
	};

	test("is_int", (v) => v.kind === "int");
	test("is_float", (v) => v.kind === "float");
	test("is_string", (v) => v.kind === "string");
	test("is_bool", (v) => v.kind === "bool");
	test("is_char", (v) => v.kind === "char");
	test("is_bytes", (v) => v.kind === "bytes");
	test("is_array", (v) => v.kind === "array" && !v.immutable);
	test("is_immutable_array", (v) => v.kind === "array" && v.immutable);
	test("is_map", (v) => v.kind === "map" && !v.immutable);
	test("is_immutable_map", (v) => v.kind === "map" && v.immutable);
	test("is_error", (v) => v.kind === "error");
	test("is_undefined", (v) => v.kind === "undefined");
	test("is_time", (v) => v.kind === "time");
	test("is_function", (v) => v.kind === "func" && v.literal);
	test("is_callable", (v) => v.kind === "func");
	test("is_iterable", (v) =>
		v.kind === "array" ||
		v.kind === "map" ||
		v.kind === "string" ||
		v.kind === "bytes");

	return table;
}

export const BUILTINS: ReadonlyMap<string, Value> = build();
