import { describe, expect, test } from "bun:test";

import { Script, TengoError } from "../src/index.ts";
import { evaluate, runFor } from "./helpers.ts";

describe("literals", () => {
	test("numbers in every form Go accepts", () => {
		expect(evaluate("42")).toBe(42);
		expect(evaluate("0x1f")).toBe(31);
		expect(evaluate("0o17")).toBe(15);
		expect(evaluate("0b1010")).toBe(10);
		expect(evaluate("017")).toBe(15);
		expect(evaluate("1.5")).toBe(1.5);
		expect(evaluate(".5")).toBe(0.5);
		expect(evaluate("1e3")).toBe(1000);
		expect(evaluate("1.5e-2")).toBe(0.015);
	});

	test("strings, raw strings and chars", () => {
		expect(evaluate('"a\\tb\\n"')).toBe("a\tb\n");
		expect(evaluate('"\\u00e9"')).toBe("é");
		expect(runFor("out := `a\\tb`", "out")).toBe("a\\tb");
		expect(evaluate("'x'")).toBe(120);
		expect(evaluate("'\\n'")).toBe(10);
	});

	test("arrays and maps", () => {
		expect(evaluate('[1, false, "foo"]')).toEqual([1, false, "foo"]);
		expect(evaluate('{a: 12.5, b: "bar"}')).toEqual({ a: 12.5, b: "bar" });
		expect(evaluate('{"in": true}["in"]')).toBe(true);
	});

	test("a literal may span lines", () => {
		expect(runFor("out := [\n\t1,\n\t2,\n]", "out")).toEqual([1, 2]);
		expect(runFor("out := {\n\ta: 1,\n\tb: 2,\n}", "out")).toEqual({
			a: 1,
			b: 2,
		});
	});
});

describe("int and float stay apart", () => {
	test("integer division truncates towards zero", () => {
		expect(evaluate("3 / 2")).toBe(1);
		expect(evaluate("-3 / 2")).toBe(-1);
		expect(evaluate("7 % 3")).toBe(1);
		expect(evaluate("-7 % 3")).toBe(-1);
	});

	test("one float makes the whole expression floating point", () => {
		expect(evaluate("3.0 / 2")).toBe(1.5);
		expect(evaluate("3 / 2.0")).toBe(1.5);
		expect(evaluate("2 + 3.5")).toBe(5.5);
	});

	test("the two types are told apart by is_int and is_float", () => {
		expect(evaluate("is_int(3 / 2)")).toBe(true);
		expect(evaluate("is_float(3.0 / 2)")).toBe(true);
		expect(evaluate("is_float(2 * 1.0)")).toBe(true);
	});

	test("dividing an int by zero is an error", () => {
		expect(() => evaluate("1 / 0")).toThrow(TengoError);
		expect(evaluate("1.0 / 0")).toBe(Number.POSITIVE_INFINITY);
	});

	test("an int crosses the boundary as an integral number", () => {
		const out = runFor("out := 10 / 3", "out");
		expect(Number.isInteger(out)).toBe(true);
	});
});

describe("operators", () => {
	test("arithmetic and comparison", () => {
		expect(evaluate("2 * 3 + 1")).toBe(7);
		expect(evaluate("2 * (3 + 1)")).toBe(8);
		expect(evaluate("1 < 2")).toBe(true);
		expect(evaluate("2 <= 2")).toBe(true);
		expect(evaluate("3 > 4")).toBe(false);
		expect(evaluate('"a" == "a"')).toBe(true);
		expect(evaluate("[1,2] == [1,2]")).toBe(true);
		expect(evaluate("{a: 1} == {a: 1}")).toBe(true);
		expect(evaluate("1 == 1.0")).toBe(true);
	});

	test("bitwise operators work at 64 bits", () => {
		expect(evaluate("6 & 3")).toBe(2);
		expect(evaluate("6 | 3")).toBe(7);
		expect(evaluate("6 ^ 3")).toBe(5);
		expect(evaluate("6 &^ 3")).toBe(4);
		expect(evaluate("1 << 10")).toBe(1024);
		expect(evaluate("-1 >> 1")).toBe(-1);
		expect(evaluate("^0")).toBe(-1);
	});

	test("the logical operators short-circuit and keep the operand", () => {
		expect(evaluate("true && false")).toBe(false);
		expect(evaluate("1 || 0")).toBe(1);
		expect(evaluate("0 || 2")).toBe(2);
		expect(evaluate("!0")).toBe(true);
		expect(evaluate("!1")).toBe(false);
		// The right side is never reached, so the missing name is no error.
		expect(evaluate("false && nope")).toBe(false);
	});

	test("the ternary operator", () => {
		expect(evaluate("true ? 1 : -1")).toBe(1);
		expect(
			runFor(
				"min := func(a, b) { return a < b ? a : b }\nout := min(5, 10)",
				"out",
			),
		).toBe(5);
	});

	test("a string on the left absorbs anything on the right", () => {
		expect(evaluate('"a" + "b"')).toBe("ab");
		expect(evaluate('"n=" + 1')).toBe("n=1");
		expect(evaluate('"v=" + [1, 2]')).toBe("v=[1, 2]");
		expect(evaluate('"ab" < "b"')).toBe(true);
	});

	test("a char is an int that prints as a character", () => {
		expect(evaluate("'a' + 1")).toBe(98);
		expect(evaluate("'b' - 'a'")).toBe(1);
		expect(evaluate("'a' < 98")).toBe(true);
		expect(evaluate("is_char('a' + 1)")).toBe(true);
		expect(evaluate("string('a' + 1)")).toBe("b");
	});

	test("arrays concatenate", () => {
		expect(evaluate("[1, 2] + [3]")).toEqual([1, 2, 3]);
	});

	test("an operation with no meaning is an error", () => {
		expect(() => evaluate("1.0 % 2.0")).toThrow(TengoError);
		expect(() => evaluate('1 + "a"')).toThrow(TengoError);
		expect(() => evaluate("{} - {}")).toThrow(TengoError);
	});
});

describe("indexing, slicing and selectors", () => {
	test("indexing", () => {
		expect(evaluate('["one", "two", "three"][1]')).toBe("two");
		expect(evaluate("[1, 2, 3][3]")).toBeUndefined();
		expect(evaluate('{a: 1, b: [2, 3, 4]}["b"][1]')).toBe(3);
		expect(evaluate("{a: 1}.a")).toBe(1);
		expect(evaluate("{a: 1}.x")).toBeUndefined();
		expect(evaluate("{a: 1}.x.y.z")).toBeUndefined();
		expect(evaluate('"abc"[1]')).toBe(98);
		expect(evaluate('bytes("AB")[1]')).toBe(66);
	});

	test("slicing clamps and never runs backwards", () => {
		expect(evaluate("[1, 2, 3, 4, 5][1:3]")).toEqual([2, 3]);
		expect(evaluate("[1, 2, 3, 4, 5][3:]")).toEqual([4, 5]);
		expect(evaluate("[1, 2, 3, 4, 5][:3]")).toEqual([1, 2, 3]);
		expect(evaluate("[1, 2, 3, 4, 5][-1:10]")).toEqual([1, 2, 3, 4, 5]);
		expect(evaluate('"hello world"[2:10]')).toBe("llo worl");
		expect(() => evaluate("[1, 2, 3][2:1]")).toThrow(TengoError);
	});

	test("a selector writes through to the map", () => {
		expect(runFor("m := {}\nm.x = 5\nout := m", "out")).toEqual({ x: 5 });
		expect(runFor('m := {}\nm["y"] = 6\nout := m', "out")).toEqual({ y: 6 });
		expect(runFor("a := [1, 2]\na[0] = 9\nout := a", "out")).toEqual([9, 2]);
	});

	test("a keyword cannot be a selector", () => {
		expect(() => Script.compile("a := {}\na.func = 1")).toThrow(TengoError);
	});
});

describe("declarations and assignment", () => {
	test(":= declares and = assigns", () => {
		expect(runFor("a := 1\na = 2\nout := a", "out")).toBe(2);
		expect(() => Script.compile("a := 1\na := 2")).not.toThrow();
		expect(() => runFor("a := 1\na := 2\nout := a", "out")).toThrow(TengoError);
		expect(() => runFor("b = 1\nout := b", "out")).toThrow(TengoError);
	});

	test("a variable may be reassigned a different type", () => {
		expect(runFor('a := 123\na = "123"\na = [1]\nout := a', "out")).toEqual([1]);
	});

	test("the compound assignments", () => {
		expect(runFor("a := 1\na += 2\nout := a", "out")).toBe(3);
		expect(runFor("a := 5\na -= 2\nout := a", "out")).toBe(3);
		expect(runFor("a := 5\na *= 2\nout := a", "out")).toBe(10);
		expect(runFor("a := 5\na /= 2\nout := a", "out")).toBe(2);
		expect(runFor("a := 5\na %= 2\nout := a", "out")).toBe(1);
		expect(runFor("a := 6\na &= 3\nout := a", "out")).toBe(2);
		expect(runFor("a := 6\na |= 3\nout := a", "out")).toBe(7);
		expect(runFor("a := 6\na ^= 3\nout := a", "out")).toBe(5);
		expect(runFor("a := 6\na &^= 3\nout := a", "out")).toBe(4);
		expect(runFor("a := 1\na <<= 3\nout := a", "out")).toBe(8);
		expect(runFor("a := 8\na >>= 3\nout := a", "out")).toBe(1);
		expect(runFor("m := {n: 1}\nm.n += 4\nout := m.n", "out")).toBe(5);
	});

	test("++ and -- are statements", () => {
		expect(runFor("a := 1\na++\na++\nout := a", "out")).toBe(3);
		expect(runFor("a := 1\na--\nout := a", "out")).toBe(0);
	});

	test("tuple assignment is rejected", () => {
		expect(() => Script.compile("a, b := 1, 2")).toThrow(TengoError);
	});

	test(":= cannot name a member", () => {
		expect(() => Script.compile("m := {}\nm.x := 1")).toThrow(TengoError);
	});
});

describe("if", () => {
	test("if, else if and else", () => {
		const source = [
			"classify := func(a) {",
			"  if a < 0 { return -1 } else if a == 0 { return 0 } else { return 1 }",
			"}",
			"out := [classify(-5), classify(0), classify(5)]",
		].join("\n");
		expect(runFor(source, "out")).toEqual([-1, 0, 1]);
	});

	test("the init form", () => {
		const source = [
			"f := func() { return -2 }",
			"out := 0",
			"if a := f(); a < 0 { out = a }",
		].join("\n");
		expect(runFor(source, "out")).toBe(-2);
	});

	test("the init variable does not leak", () => {
		expect(() => runFor("if a := 1; a > 0 { }\nout := a", "out")).toThrow(
			TengoError,
		);
	});

	test("a body may shadow a name from the header", () => {
		expect(runFor("if a := 1; a > 0 { a := 2 }\nout := 1", "out")).toBe(1);
	});

	test("anything can be a condition", () => {
		expect(runFor('out := 0\nif "x" { out = 1 }', "out")).toBe(1);
		expect(runFor("out := 0\nif [] { out = 1 }", "out")).toBe(0);
		// A float is falsy only when it is NaN, so 0.0 is true.
		expect(runFor("out := 0\nif 0.0 { out = 1 }", "out")).toBe(1);
		expect(runFor("out := 0\nif 0 { out = 1 }", "out")).toBe(0);
	});
});

describe("for", () => {
	test("init, condition and post", () => {
		expect(runFor("out := 0\nfor a := 0; a < 10; a++ { out += a }", "out")).toBe(
			45,
		);
	});

	test("condition only", () => {
		expect(runFor("a := 0\nout := 0\nfor a < 5 { out += a\na++ }", "out")).toBe(10);
	});

	test("no header, left by break", () => {
		expect(runFor("out := 0\nfor { out++\nif out == 3 { break } }", "out")).toBe(3);
	});

	test("break and continue", () => {
		const source = [
			"out := 0",
			"for i := 0; i < 10; i++ {",
			"  if i == 2 { continue }",
			"  if i == 5 { break }",
			"  out += i",
			"}",
		].join("\n");
		expect(runFor(source, "out")).toBe(8);
	});

	test("a return inside a loop leaves the function", () => {
		const source = [
			"first := func(a) { for v in a { if v > 2 { return v } }\nreturn -1 }",
			"out := first([1, 2, 3, 4])",
		].join("\n");
		expect(runFor(source, "out")).toBe(3);
	});
});

describe("for ... in", () => {
	test("over an array, with and without the index", () => {
		expect(
			runFor("out := []\nfor v in [1, 2, 3] { out = append(out, v) }", "out"),
		).toEqual([1, 2, 3]);
		expect(
			runFor(
				"out := []\nfor i, v in [10, 20] { out = append(out, [i, v]) }",
				"out",
			),
		).toEqual([
			[0, 10],
			[1, 20],
		]);
	});

	test("over a map, in insertion order", () => {
		expect(
			runFor(
				"out := []\nfor k, v in {k1: 1, k2: 2} { out = append(out, k + string(v)) }",
				"out",
			),
		).toEqual(["k11", "k22"]);
		expect(
			runFor("out := []\nfor v in {a: 1, b: 2} { out = append(out, v) }", "out"),
		).toEqual([1, 2]);
	});

	test("over a string, yielding chars", () => {
		expect(
			runFor(
				'out := []\nfor i, c in "abc" { out = append(out, string(c) + string(i)) }',
				"out",
			),
		).toEqual(["a0", "b1", "c2"]);
	});

	test("over bytes, yielding ints", () => {
		expect(
			runFor('out := []\nfor i, b in bytes("AB") { out = append(out, b) }', "out"),
		).toEqual([65, 66]);
	});

	test("over undefined, which iterates nothing", () => {
		expect(runFor("out := 0\nfor v in undefined { out++ }", "out")).toBe(0);
	});

	test("a loop body may shadow the loop variable", () => {
		expect(runFor("out := 0\nfor v in [1, 2] { v := 9\nout += v }", "out")).toBe(
			18,
		);
	});

	test("something that is not iterable is an error", () => {
		expect(() => runFor("for v in 1 { }\nout := 1", "out")).toThrow(TengoError);
	});
});

describe("functions", () => {
	test("a literal, a closure and recursion", () => {
		expect(
			runFor("add := func(a, b) { return a + b }\nout := add(19, 84)", "out"),
		).toBe(103);
		expect(
			runFor(
				"adder := func(base) { return func(x) { return base + x } }\nout := adder(5)(4)",
				"out",
			),
		).toBe(9);
		expect(
			runFor(
				"fib := func(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }\nout := fib(20)",
				"out",
			),
		).toBe(6765);
	});

	test("immediately invoked, with no return value", () => {
		expect(runFor("out := func() { return 42 }()", "out")).toBe(42);
		expect(runFor("out := func() { b := 4 }()", "out")).toBeUndefined();
	});

	test("variadic parameters", () => {
		expect(
			runFor(
				"f := func(a, b, ...c) { return [a, b, c] }\nout := f(1, 2, 3, 4)",
				"out",
			),
		).toEqual([1, 2, [3, 4]]);
		expect(
			runFor("f := func(a, ...b) { return [a, b] }\nout := f(1)", "out"),
		).toEqual([1, []]);
		expect(
			runFor(
				"g := func(a) { return func(b, ...c) { return [a, b, c] } }\nout := g(1)(2, 3, 4)",
				"out",
			),
		).toEqual([1, 2, [3, 4]]);
	});

	test("the argument count has to match", () => {
		expect(() => runFor("f := func(a, b) {}\nout := f(1, 2, 3)", "out")).toThrow(
			TengoError,
		);
		expect(() => runFor("f := func(a, b) {}\nout := f(1)", "out")).toThrow(
			TengoError,
		);
	});

	test("an array spreads into the last parameter", () => {
		expect(
			runFor(
				"f := func(a, b, c) { return a + b + c }\nout := f([1, 2, 3]...)",
				"out",
			),
		).toBe(6);
		expect(
			runFor(
				"f := func(a, b, c) { return a + b + c }\nout := f(1, [2, 3]...)",
				"out",
			),
		).toBe(6);
		expect(
			runFor("f := func(a, ...b) { return [a, b] }\nout := f([1, 2, 3]...)", "out"),
		).toEqual([1, [2, 3]]);
	});

	test("a closure shares the variable it captured", () => {
		const source = [
			"count := 0",
			"bump := func() { count++ }",
			"bump()",
			"bump()",
			"out := count",
		].join("\n");
		expect(runFor(source, "out")).toBe(2);
	});

	test("calling something that is not callable is an error", () => {
		expect(() => runFor("out := 1\nout()", "out")).toThrow(TengoError);
	});

	test("runaway recursion is reported rather than crashing", () => {
		expect(() => runFor("f := func() { return f() }\nout := f()", "out")).toThrow(
			TengoError,
		);
	});
});

describe("comments and statement ends", () => {
	test("line and block comments", () => {
		expect(runFor("out := 5 // trailing", "out")).toBe(5);
		expect(runFor("/* leading */\nout := 5", "out")).toBe(5);
		expect(runFor("out := /* inline */ 5", "out")).toBe(5);
	});

	test("a comment that eats a newline still ends the statement", () => {
		expect(runFor("a := 1 /* one\ntwo */\nout := a", "out")).toBe(1);
	});

	test("semicolons may be written out", () => {
		expect(runFor("a := 1; b := 2; out := a + b", "out")).toBe(3);
	});
});

describe("immutability", () => {
	test("immutable marks a container read-only", () => {
		expect(evaluate("is_immutable_array(immutable([1, 2]))")).toBe(true);
		expect(evaluate("is_immutable_map(immutable({a: 1}))")).toBe(true);
		expect(() => runFor("a := immutable([1])\na[0] = 2\nout := a", "out")).toThrow(
			TengoError,
		);
		expect(() =>
			runFor("m := immutable({a: 1})\nm.a = 2\nout := m", "out"),
		).toThrow(TengoError);
	});

	test("rebinding the name is unrelated to the value", () => {
		expect(runFor("a := immutable([1])\na = false\nout := a", "out")).toBe(false);
	});

	test("immutability is shallow unless applied again", () => {
		expect(
			runFor("a := immutable({b: 4, c: [1, 2, 3]})\na.c[1] = 5\nout := a.c", "out"),
		).toEqual([1, 5, 3]);
		expect(() =>
			runFor("a := immutable({c: immutable([1, 2])})\na.c[1] = 5\nout := a", "out"),
		).toThrow(TengoError);
	});

	test("copy gives back a mutable value", () => {
		expect(
			runFor(
				"a := immutable([1, 2])\nb := copy(a)\nb[0] = 9\nout := [a, b]",
				"out",
			),
		).toEqual([
			[1, 2],
			[9, 2],
		]);
	});
});

describe("error values", () => {
	test("an error wraps a value, read through .value", () => {
		expect(evaluate('error("oops").value')).toBe("oops");
		expect(evaluate("error(1 + 2).value")).toBe(3);
		expect(evaluate('is_error(error("x"))')).toBe(true);
		// An error is always falsy, which is how a caller tests one.
		expect(evaluate('error("x") ? 1 : 2')).toBe(2);
	});
});

describe("export", () => {
	test("a top-level export is ignored in a main program", () => {
		expect(runFor("out := 1\nexport out", "out")).toBe(1);
	});

	test("an export inside a function is rejected", () => {
		expect(() => Script.compile("f := func() { export 1 }")).toThrow(TengoError);
	});
});
