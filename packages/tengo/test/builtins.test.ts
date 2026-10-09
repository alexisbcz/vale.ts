import { describe, expect, test } from "bun:test";

import { TengoError } from "../src/index.ts";
import { evaluate, runFor } from "./helpers.ts";

describe("len", () => {
	test("counts elements, characters, bytes and keys", () => {
		expect(evaluate("len([1, 2, 3])")).toBe(3);
		expect(evaluate('len("hello")')).toBe(5);
		expect(evaluate('len(bytes("hello"))')).toBe(5);
		expect(evaluate("len({a: 1, b: 2})")).toBe(2);
		expect(evaluate("len([])")).toBe(0);
	});

	test("anything else is an error", () => {
		expect(() => evaluate("len(1)")).toThrow(TengoError);
		expect(() => evaluate("len()")).toThrow(TengoError);
	});
});

describe("copy", () => {
	test("a copy is deep and independent of the original", () => {
		const source = [
			"v1 := [1, 2, 3]",
			"v2 := v1",
			"v3 := copy(v1)",
			"v1[1] = 0",
			"out := [v2[1], v3[1]]",
		].join("\n");
		expect(runFor(source, "out")).toEqual([0, 2]);
	});

	test("nested containers are copied too", () => {
		const source = [
			"a := {inner: [1, 2]}",
			"b := copy(a)",
			"b.inner[0] = 9",
			"out := [a.inner[0], b.inner[0]]",
		].join("\n");
		expect(runFor(source, "out")).toEqual([1, 9]);
	});
});

describe("append", () => {
	test("returns a new array and leaves the original alone", () => {
		expect(runFor("v := [1]\nv = append(v, 2, 3)\nout := v", "out")).toEqual([
			1, 2, 3,
		]);
		expect(runFor("a := [1]\nb := append(a, 2)\nout := [a, b]", "out")).toEqual([
			[1],
			[1, 2],
		]);
	});

	test("the first argument has to be an array", () => {
		expect(() => evaluate('append("ab", "c")')).toThrow(TengoError);
		expect(() => evaluate("append([1])")).toThrow(TengoError);
	});
});

describe("delete", () => {
	test("removes a key and mutates the map", () => {
		expect(
			runFor('v := {key: "value"}\ndelete(v, "key")\nout := v', "out"),
		).toEqual({});
		expect(
			runFor('v := {key: "value"}\ndelete(v, "missing")\nout := v', "out"),
		).toEqual({ key: "value" });
		expect(evaluate('delete({a: 1}, "a")')).toBeUndefined();
	});

	test("the arguments are checked", () => {
		expect(() => evaluate("delete({})")).toThrow(TengoError);
		expect(() => evaluate("delete({}, 1)")).toThrow(TengoError);
		expect(() => evaluate('delete([1], "a")')).toThrow(TengoError);
	});
});

describe("splice", () => {
	// The cases from Tengo's own documentation.
	test("deletes from a start index", () => {
		expect(
			runFor("v := [1, 2, 3]\nitems := splice(v, 0)\nout := [items, v]", "out"),
		).toEqual([[1, 2, 3], []]);
		expect(
			runFor("v := [1, 2, 3]\nitems := splice(v, 1)\nout := [items, v]", "out"),
		).toEqual([[2, 3], [1]]);
		expect(
			runFor("v := [1, 2, 3]\nitems := splice(v, 0, 1)\nout := [items, v]", "out"),
		).toEqual([[1], [2, 3]]);
	});

	test("a delete count past the end is truncated", () => {
		expect(
			runFor(
				'v := ["a", "b", "c"]\nitems := splice(v, 1, 99)\nout := [items, v]',
				"out",
			),
		).toEqual([["b", "c"], ["a"]]);
	});

	test("appends, replaces and inserts", () => {
		expect(
			runFor(
				'v := ["a", "b", "c"]\nitems := splice(v, 3, 0, "d", "e")\nout := [items, v]',
				"out",
			),
		).toEqual([[], ["a", "b", "c", "d", "e"]]);
		expect(
			runFor(
				'v := ["a", "b", "c"]\nitems := splice(v, 2, 1, "d")\nout := [items, v]',
				"out",
			),
		).toEqual([["c"], ["a", "b", "d"]]);
		expect(
			runFor(
				'v := ["a", "b", "c"]\nitems := splice(v, 0, 0, "d", "e")\nout := [items, v]',
				"out",
			),
		).toEqual([[], ["d", "e", "a", "b", "c"]]);
		expect(
			runFor(
				'v := ["a", "b", "c"]\nitems := splice(v, 1, 1, "d", "e")\nout := [items, v]',
				"out",
			),
		).toEqual([["b"], ["a", "d", "e", "c"]]);
	});

	test("the arguments are checked", () => {
		expect(() => evaluate("splice({})")).toThrow(TengoError);
		expect(() => runFor("v := [1]\nout := splice(v, 5)", "out")).toThrow(
			TengoError,
		);
	});
});

describe("range", () => {
	test("counts up, down and by a step", () => {
		expect(evaluate("range(0, 5)")).toEqual([0, 1, 2, 3, 4]);
		expect(evaluate("range(5, 0)")).toEqual([5, 4, 3, 2, 1]);
		expect(evaluate("range(0, 10, 3)")).toEqual([0, 3, 6, 9]);
		expect(evaluate("range(3, 3)")).toEqual([]);
	});

	test("the step has to be positive and the bounds have to be ints", () => {
		expect(() => evaluate("range(0, 5, 0)")).toThrow(TengoError);
		expect(() => evaluate("range(0, 5, -1)")).toThrow(TengoError);
		expect(() => evaluate("range(0.0, 5)")).toThrow(TengoError);
		expect(() => evaluate("range(0)")).toThrow(TengoError);
	});
});

describe("conversions", () => {
	test("the examples from the tutorial", () => {
		expect(evaluate("string(1984)")).toBe("1984");
		expect(evaluate('int("-999")')).toBe(-999);
		expect(evaluate("float(-51)")).toBe(-51);
		expect(evaluate("bool(1)")).toBe(true);
		expect(evaluate('string(char("X"[0]))')).toBe("X");
		expect(evaluate("char(89)")).toBe(89);
		expect(evaluate("string(char(89))")).toBe("Y");
	});

	test("a failed conversion is undefined, or the fallback", () => {
		expect(evaluate('int("foo")')).toBeUndefined();
		expect(evaluate("int(undefined, 10)")).toBe(10);
		expect(evaluate("int(undefined, false)")).toBe(false);
		expect(evaluate('string(undefined, "foo")')).toBe("foo");
		expect(evaluate("float(undefined, 19.84)")).toBe(19.84);
		expect(evaluate("char(undefined, false)")).toBe(false);
	});

	test("float and int round-trip the way Go's conversions do", () => {
		expect(evaluate("int(19.84)")).toBe(19);
		expect(evaluate("int(-19.84)")).toBe(-19);
		expect(evaluate('float("19.84")')).toBe(19.84);
		expect(evaluate("string(19.84)")).toBe("19.84");
		expect(evaluate("string(true)")).toBe("true");
		expect(evaluate("string([1, 2])")).toBe("[1, 2]");
		expect(evaluate("string({a: 1})")).toBe("{a: 1}");
	});

	test("bytes converts, and a lone int allocates", () => {
		expect([...(evaluate('bytes("foo")') as Uint8Array)]).toEqual([102, 111, 111]);
		expect((evaluate("bytes(4)") as Uint8Array).length).toBe(4);
		expect(evaluate('string(bytes("foo"))')).toBe("foo");
	});

	test("time reads an int as Unix seconds", () => {
		expect(evaluate("is_time(time(1257894000))")).toBe(true);
		expect((evaluate("time(1257894000)") as Date).toISOString()).toBe(
			"2009-11-10T23:00:00.000Z",
		);
		expect(evaluate('time("x")')).toBeUndefined();
	});
});

describe("type tests", () => {
	test("each one answers for its own type only", () => {
		expect(evaluate("is_int(1)")).toBe(true);
		expect(evaluate("is_int(1.0)")).toBe(false);
		expect(evaluate("is_float(1.0)")).toBe(true);
		expect(evaluate('is_string("a")')).toBe(true);
		expect(evaluate("is_bool(true)")).toBe(true);
		expect(evaluate("is_char('a')")).toBe(true);
		expect(evaluate('is_bytes(bytes("a"))')).toBe(true);
		expect(evaluate("is_array([1])")).toBe(true);
		expect(evaluate("is_array(immutable([1]))")).toBe(false);
		expect(evaluate("is_immutable_array(immutable([1]))")).toBe(true);
		expect(evaluate("is_map({})")).toBe(true);
		expect(evaluate("is_immutable_map(immutable({}))")).toBe(true);
		expect(evaluate('is_error(error("x"))')).toBe(true);
		expect(evaluate("is_undefined(undefined)")).toBe(true);
		expect(evaluate("is_undefined(1)")).toBe(false);
	});

	test("is_function is false for a builtin, is_callable is true", () => {
		expect(evaluate("is_function(func() {})")).toBe(true);
		expect(evaluate("is_function(len)")).toBe(false);
		expect(evaluate("is_callable(len)")).toBe(true);
		expect(evaluate("is_callable(func() {})")).toBe(true);
		expect(evaluate("is_callable(1)")).toBe(false);
	});

	test("is_iterable covers the four containers", () => {
		expect(evaluate("is_iterable([1])")).toBe(true);
		expect(evaluate("is_iterable({})")).toBe(true);
		expect(evaluate('is_iterable("a")')).toBe(true);
		expect(evaluate('is_iterable(bytes("a"))')).toBe(true);
		expect(evaluate("is_iterable(1)")).toBe(false);
	});
});

describe("type_name", () => {
	test("names every type the way Tengo does", () => {
		expect(evaluate("type_name(1)")).toBe("int");
		expect(evaluate("type_name(1.0)")).toBe("float");
		expect(evaluate('type_name("str")')).toBe("string");
		expect(evaluate("type_name(true)")).toBe("bool");
		expect(evaluate("type_name('c')")).toBe("char");
		expect(evaluate('type_name(bytes("a"))')).toBe("bytes");
		expect(evaluate("type_name([1, 2, 3])")).toBe("array");
		expect(evaluate("type_name(immutable([1]))")).toBe("immutable-array");
		expect(evaluate("type_name({})")).toBe("map");
		expect(evaluate("type_name(immutable({}))")).toBe("immutable-map");
		expect(evaluate("type_name(undefined)")).toBe("undefined");
		expect(evaluate('type_name(error("x"))')).toBe("error");
		expect(evaluate("type_name(func() {})")).toBe("compiled-function");
		expect(evaluate("type_name(len)")).toBe("builtin-function:len");
	});
});

describe("freeze", () => {
	test("freezes every container in the tree", () => {
		const source = [
			'config := freeze({limits: {max: 3}, tags: ["prod"]})',
			"out := [",
			"  is_immutable_map(config),",
			"  is_immutable_map(config.limits),",
			"  is_immutable_array(config.tags),",
			"]",
		].join("\n");
		expect(runFor(source, "out")).toEqual([true, true, true]);
	});
});

describe("format", () => {
	test("the general verbs", () => {
		expect(evaluate('format("Foo: %v", [1, 2, 3])')).toBe("Foo: [1, 2, 3]");
		expect(evaluate('format("%v", 1.5)')).toBe("1.5");
		expect(evaluate('format("%v", true)')).toBe("true");
		expect(evaluate('format("%T %T", 1, 1.0)')).toBe("int float");
		expect(evaluate('format("100%%")')).toBe("100%");
	});

	test("integer verbs", () => {
		expect(evaluate('format("%d", 42)')).toBe("42");
		expect(evaluate('format("%b", 5)')).toBe("101");
		expect(evaluate('format("%o", 8)')).toBe("10");
		expect(evaluate('format("%O", 8)')).toBe("0o10");
		expect(evaluate('format("%x %X", 255, 255)')).toBe("ff FF");
		expect(evaluate('format("%#x", 255)')).toBe("0xff");
		expect(evaluate('format("%c", 89)')).toBe("Y");
		expect(evaluate('format("%U", 120)')).toBe("U+0078");
		expect(evaluate('format("%#U", 120)')).toBe("U+0078 'x'");
		expect(evaluate('format("%+d", 42)')).toBe("+42");
		expect(evaluate('format("%05d", 42)')).toBe("00042");
		expect(evaluate('format("%-5d|", 42)')).toBe("42   |");
	});

	test("float verbs", () => {
		expect(evaluate('format("%f", 3.5)')).toBe("3.500000");
		expect(evaluate('format("%.2f", 3.14159)')).toBe("3.14");
		expect(evaluate('format("%6.3f", 12.345)')).toBe("12.345");
		expect(evaluate('format("%9.2f|", 3.14159)')).toBe("     3.14|");
		expect(evaluate('format("%e", 1234.5)')).toBe("1.234500e+03");
		expect(evaluate('format("%E", 1234.5)')).toBe("1.234500E+03");
		expect(evaluate('format("%g", 1234.5)')).toBe("1234.5");
		expect(evaluate('format("%.3g", 12.345)')).toBe("12.3");
		expect(evaluate('format("%g", 0.00001)')).toBe("1e-05");
		expect(evaluate('format("%08.3f", -3.14159)')).toBe("-003.142");
	});

	test("string verbs", () => {
		expect(evaluate('format("%s", "hi")')).toBe("hi");
		expect(evaluate('format("%q", "a\\nb")')).toBe('"a\\nb"');
		expect(evaluate('format("%.2s", "hello")')).toBe("he");
		expect(evaluate('format("%6s|", "hi")')).toBe("    hi|");
		expect(evaluate('format("%-6s|", "hi")')).toBe("hi    |");
		expect(evaluate('format("%x", "AB")')).toBe("4142");
	});

	test("the width and precision can come from an argument", () => {
		expect(evaluate('format("%*d", 5, 42)')).toBe("   42");
		expect(evaluate('format("%.*f", 2, 3.14159)')).toBe("3.14");
	});

	test("a wrong or missing argument is reported in the output", () => {
		expect(evaluate('format("%d")')).toBe("%!d(MISSING)");
		expect(evaluate('format("%d", "x")')).toContain("%!d(");
		expect(evaluate('format("a", 1)')).toContain("%!(EXTRA");
	});

	test("the format has to be a string", () => {
		expect(() => evaluate("format(1)")).toThrow(TengoError);
		expect(() => evaluate("format()")).toThrow(TengoError);
	});
});
