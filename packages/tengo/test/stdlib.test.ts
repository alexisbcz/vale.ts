import { afterEach, describe, expect, test } from "bun:test";

import { Script, setPrinter, TengoError } from "../src/index.ts";
import { evaluateWithStdlib as ev, runFor } from "./helpers.ts";

describe("text: regular expressions", () => {
	test("re_match", () => {
		expect(ev('text.re_match("[a-z]+", "Abc")')).toBe(true);
		expect(ev('text.re_match("^[a-z]", "Abc")')).toBe(false);
		expect(ev('text.re_match("(?i)^abc$", "ABC")')).toBe(true);
	});

	test("re_find reports every group with its bounds", () => {
		expect(ev('text.re_find("a(b+)", "xabbby abb", -1)')).toEqual([
			[
				{ text: "abbb", begin: 1, end: 5 },
				{ text: "bbb", begin: 2, end: 5 },
			],
			[
				{ text: "abb", begin: 7, end: 10 },
				{ text: "bb", begin: 8, end: 10 },
			],
		]);
	});

	test("re_find with no count reports the first match only", () => {
		expect(ev('text.re_find("a(b+)", "xabbby abb")')).toEqual([
			[
				{ text: "abbb", begin: 1, end: 5 },
				{ text: "bbb", begin: 2, end: 5 },
			],
		]);
		expect(ev('text.re_find("z", "abc")')).toBeUndefined();
	});

	test("re_replace expands $1 and ${name}", () => {
		expect(ev('text.re_replace("a(b+)", "xabbby", "[$1]")')).toBe("x[bbb]y");
		expect(ev('text.re_replace("(?P<x>a)b", "ab", "${x}!")')).toBe("a!");
		expect(ev('text.re_replace("a", "aaa", "b")')).toBe("bbb");
	});

	test("re_split, with and without a limit", () => {
		expect(ev('text.re_split(",", "a,b,c", -1)')).toEqual(["a", "b", "c"]);
		expect(ev('text.re_split(",", "a,b,c", 2)')).toEqual(["a", "b,c"]);
		expect(ev('text.re_split(",", "abc", -1)')).toEqual(["abc"]);
	});

	test("re_compile gives an object with match, find, replace and split", () => {
		expect(ev('text.re_compile("a+").match("baaa")')).toBe(true);
		expect(ev('text.re_compile("a(b)").replace("ab", "<$1>")')).toBe("<b>");
		expect(ev('text.re_compile(",").split("a,b", -1)')).toEqual(["a", "b"]);
		expect(ev('text.re_compile("b+").find("abbc")')).toEqual([
			[{ text: "bb", begin: 1, end: 3 }],
		]);
	});

	test("a pattern that will not compile comes back as an error value", () => {
		expect(ev('is_error(text.re_compile("("))')).toBe(true);
		expect(ev('is_error(text.re_match("(", "a"))')).toBe(true);
	});

	test("the RE2 dialect is what a rule author gets", () => {
		// `(?s)` lets `.` cross a newline, which both script rules Vale ships
		// depend on.
		expect(ev('text.re_match("(?s)a.b", "a\\nb")')).toBe(true);
		expect(ev('text.re_match("a.b", "a\\nb")')).toBe(false);
		expect(
			ev(
				'text.re_replace("(?s) *(\\n```.*?```\\n)", "x \\n```go\\ny\\n```\\nz", "")',
			),
		).toBe("xz");
		// `\s` is Go's class, `[\t\n\f\r ]`, not JavaScript's wider one.
		expect(ev('text.re_match("^\\\\s$", "\\t")')).toBe(true);
		expect(ev('text.re_match("^\\\\s$", "\\u00a0")')).toBe(false);
	});
});

describe("text: strings", () => {
	test("the comparison and search functions", () => {
		expect(ev('text.compare("a", "b")')).toBe(-1);
		expect(ev('text.compare("b", "a")')).toBe(1);
		expect(ev('text.compare("a", "a")')).toBe(0);
		expect(ev('text.contains("chicken", "ken")')).toBe(true);
		expect(ev('text.contains_any("abc", "xq c")')).toBe(true);
		expect(ev('text.contains_any("abc", "xyz")')).toBe(false);
		expect(ev('text.count("cheese", "e")')).toBe(3);
		expect(ev('text.count("abc", "")')).toBe(4);
		expect(ev('text.equal_fold("Go", "GO")')).toBe(true);
		expect(ev('text.has_prefix("chicken", "chick")')).toBe(true);
		expect(ev('text.has_suffix("chicken", "ken")')).toBe(true);
		expect(ev('text.index("chicken", "ken")')).toBe(4);
		expect(ev('text.index("chicken", "x")')).toBe(-1);
		expect(ev('text.index_any("chicken", "aeiouy")')).toBe(2);
		expect(ev('text.index_any("abc", "xyz")')).toBe(-1);
		expect(ev('text.last_index("go gopher", "go")')).toBe(3);
		expect(ev('text.last_index_any("go gopher", "aeiouy")')).toBe(7);
	});

	test("fields, join, repeat and replace", () => {
		expect(ev('text.fields("  foo bar  baz   ")')).toEqual(["foo", "bar", "baz"]);
		expect(ev('text.fields("   ")')).toEqual([]);
		expect(ev('text.join(["a", "b", "c"], "-")')).toBe("a-b-c");
		expect(ev('text.join([1, 2], ",")')).toBe("1,2");
		expect(ev('text.repeat("na", 2)')).toBe("nana");
		expect(ev('text.replace("oink oink oink", "oink", "moo", 2)')).toBe(
			"moo moo oink",
		);
		expect(ev('text.replace("oink oink", "oink", "moo", -1)')).toBe("moo moo");
	});

	test("substr and the split family", () => {
		expect(ev('text.substr("hello", 1, 3)')).toBe("el");
		expect(ev('text.substr("hello", 2)')).toBe("llo");
		expect(ev('text.substr("hello", -5, 99)')).toBe("hello");
		expect(ev('text.split("a,b,c", ",")')).toEqual(["a", "b", "c"]);
		expect(ev('text.split("abc", "")')).toEqual(["a", "b", "c"]);
		expect(ev('text.split_after("a,b,c", ",")')).toEqual(["a,", "b,", "c"]);
		expect(ev('text.split_n("a,b,c", ",", 2)')).toEqual(["a", "b,c"]);
		expect(ev('text.split_after_n("a,b,c", ",", 2)')).toEqual(["a,", "b,c"]);
		expect(ev('text.split("a\\nb\\n", "\\n")')).toEqual(["a", "b", ""]);
	});

	test("case conversion", () => {
		expect(ev('text.title("her royal highness")')).toBe("Her Royal Highness");
		expect(ev('text.to_lower("ABC")')).toBe("abc");
		expect(ev('text.to_upper("abc")')).toBe("ABC");
		expect(ev('text.to_title("loud noises")')).toBe("LOUD NOISES");
	});

	test("padding", () => {
		expect(ev('text.pad_left("5", 3, "0")')).toBe("005");
		expect(ev('text.pad_right("5", 3, "0")')).toBe("500");
		expect(ev('text.pad_left("5", 3)')).toBe("  5");
		expect(ev('text.pad_left("x", 7, "ab")')).toBe("abababx");
		// A string already at or past the width is left alone.
		expect(ev('text.pad_left("hello", 3, "0")')).toBe("hello");
	});

	test("trimming, where a cutset is a set of characters", () => {
		expect(ev('text.trim("\\u00a1\\u00a1Hello!!", "!\\u00a1")')).toBe("Hello");
		expect(ev('text.trim_left("xxhixx", "x")')).toBe("hixx");
		expect(ev('text.trim_right("xxhixx", "x")')).toBe("xxhi");
		expect(ev('text.trim_space(" \\t hi \\n")')).toBe("hi");
		expect(ev('text.trim_prefix("abc", "ab")')).toBe("c");
		expect(ev('text.trim_prefix("abc", "z")')).toBe("abc");
		expect(ev('text.trim_suffix("abc", "bc")')).toBe("a");
	});
});

describe("text: strconv", () => {
	test("parsing and formatting numbers", () => {
		expect(ev('text.atoi("42")')).toBe(42);
		expect(ev('is_error(text.atoi("x"))')).toBe(true);
		expect(ev("text.format_bool(true)")).toBe("true");
		expect(ev('text.format_float(3.1415, "f", 2, 64)')).toBe("3.14");
		expect(ev('text.format_float(1234.5678, "e", 3, 64)')).toBe("1.235e+03");
		expect(ev("text.format_int(255, 16)")).toBe("ff");
		expect(ev("text.format_int(255, 2)")).toBe("11111111");
		expect(ev("text.itoa(7)")).toBe("7");
		expect(ev('text.parse_bool("T")')).toBe(true);
		expect(ev('text.parse_bool("FALSE")')).toBe(false);
		expect(ev('is_error(text.parse_bool("yes"))')).toBe(true);
		expect(ev('text.parse_float("19.84", 64)')).toBe(19.84);
		expect(ev('is_error(text.parse_float("x", 64))')).toBe(true);
		expect(ev('text.parse_int("ff", 16, 64)')).toBe(255);
		expect(ev('text.parse_int("0x1f", 0, 64)')).toBe(31);
		expect(ev('is_error(text.parse_int("zz", 16, 64))')).toBe(true);
	});

	test("quoting round-trips", () => {
		expect(ev('text.quote("a\\tb")')).toBe('"a\\tb"');
		expect(ev('text.unquote(text.quote("a\\tb"))')).toBe("a\tb");
		expect(ev('is_error(text.unquote("nope"))')).toBe(true);
	});

	test("an argument is converted rather than type-checked", () => {
		// Tengo's wrappers read a string through `ToString`, so an int is a
		// valid argument wherever a string is wanted.
		expect(ev("text.atoi(1)")).toBe(1);
		expect(ev("text.contains(123, 2)")).toBe(true);
	});

	test("the argument count is checked", () => {
		expect(() => ev('text.split("a")')).toThrow(TengoError);
		expect(() => ev("text.atoi()")).toThrow(TengoError);
	});
});

describe("math", () => {
	test("the constants", () => {
		expect(ev("math.pi")).toBeCloseTo(Math.PI, 15);
		expect(ev("math.e")).toBeCloseTo(Math.E, 15);
		expect(ev("math.phi")).toBeCloseTo(1.618033988749895, 15);
		expect(ev("math.sqrt2")).toBeCloseTo(Math.SQRT2, 15);
		expect(ev("math.ln2")).toBeCloseTo(Math.LN2, 15);
		expect(ev("math.maxInt8")).toBe(127);
		expect(ev("math.minInt8")).toBe(-128);
		expect(ev("math.maxInt32")).toBe(2147483647);
		expect(ev("math.maxFloat64")).toBe(Number.MAX_VALUE);
		expect(ev("is_int(math.maxInt64)")).toBe(true);
		expect(ev("is_float(math.pi)")).toBe(true);
	});

	test("the everyday functions", () => {
		expect(ev("math.abs(-19.84)")).toBe(19.84);
		expect(ev("math.ceil(1.2)")).toBe(2);
		expect(ev("math.floor(1.8)")).toBe(1);
		expect(ev("math.trunc(-1.7)")).toBe(-1);
		expect(ev("math.sqrt(9)")).toBe(3);
		expect(ev("math.pow(2, 10)")).toBe(1024);
		expect(ev("math.pow10(3)")).toBe(1000);
		expect(ev("math.exp2(10)")).toBe(1024);
		expect(ev("math.max(1, 2)")).toBe(2);
		expect(ev("math.min(1, 2)")).toBe(1);
		expect(ev("math.mod(7, 3)")).toBe(1);
		expect(ev("math.hypot(3, 4)")).toBe(5);
		expect(ev("math.cbrt(27)")).toBe(3);
		expect(ev("math.log10(1000)")).toBe(3);
		expect(ev("math.log2(8)")).toBe(3);
		expect(ev("math.dim(5, 7)")).toBe(0);
		expect(ev("math.dim(7, 5)")).toBe(2);
		expect(ev("math.copysign(3, -1)")).toBe(-3);
		expect(ev("math.ldexp(0.5, 4)")).toBe(8);
	});

	test("every function returns a float, even from int arguments", () => {
		expect(ev("is_float(math.sqrt(4))")).toBe(true);
		expect(ev("is_float(math.abs(-1))")).toBe(true);
		expect(ev("is_int(math.ilogb(8.0))")).toBe(true);
	});

	test("the special values", () => {
		expect(ev("math.is_nan(math.nan())")).toBe(true);
		expect(ev("math.is_nan(1.0)")).toBe(false);
		expect(ev("math.is_inf(math.inf(1), 1)")).toBe(true);
		expect(ev("math.is_inf(math.inf(-1), 1)")).toBe(false);
		expect(ev("math.is_inf(math.inf(-1), 0)")).toBe(true);
		expect(ev("math.signbit(-1.0)")).toBe(true);
		expect(ev("math.signbit(1.0)")).toBe(false);
		expect(ev("math.nextafter(1.0, 2.0)")).toBe(1 + Number.EPSILON);
	});

	test("trigonometry", () => {
		expect(ev("math.sin(0)")).toBe(0);
		expect(ev("math.cos(0)")).toBe(1);
		expect(ev("math.atan2(1, 1)")).toBeCloseTo(Math.PI / 4, 15);
		expect(ev("math.tanh(0)")).toBe(0);
		expect(ev("math.asinh(0)")).toBe(0);
	});

	test("the functions JavaScript has no counterpart for", () => {
		// Approximations, so these are checked to about a part in 10^8; see the
		// note at the top of stdlib/math.ts.
		expect(ev("math.erf(1.0)")).toBeCloseTo(0.8427007929497149, 7);
		expect(ev("math.erfc(1.0)")).toBeCloseTo(0.15729920705028513, 7);
		expect(ev("math.gamma(5.0)")).toBeCloseTo(24, 10);
		expect(ev("math.gamma(0.5)")).toBeCloseTo(Math.sqrt(Math.PI), 12);
		expect(ev("math.j0(1.0)")).toBeCloseTo(0.7651976865579666, 7);
		expect(ev("math.j1(1.0)")).toBeCloseTo(0.44005058574493355, 7);
		expect(ev("math.jn(2, 1.0)")).toBeCloseTo(0.11490348493190047, 7);
		expect(ev("math.jn(2, 5.0)")).toBeCloseTo(0.04656511627775221, 7);
		expect(ev("math.y0(1.0)")).toBeCloseTo(0.08825696421567698, 7);
		expect(ev("math.y1(1.0)")).toBeCloseTo(-0.7812128213002888, 7);
		expect(ev("math.yn(2, 1.0)")).toBeCloseTo(-1.6506826068162546, 7);
	});

	test("the argument count is checked", () => {
		expect(() => ev("math.sqrt()")).toThrow(TengoError);
		expect(() => ev("math.pow(2)")).toThrow(TengoError);
	});
});

describe("fmt", () => {
	const written: string[] = [];

	afterEach(() => {
		written.length = 0;
		setPrinter((text) => {
			process.stdout.write(text);
		});
	});

	function capture(source: string): string {
		written.length = 0;
		setPrinter((text) => {
			written.push(text);
		});
		const script = Script.compile(source);
		script.clone().run();
		return written.join("");
	}

	test("sprintf is the format builtin under another name", () => {
		expect(ev('fmt.sprintf("%s=%d", "a", 1)')).toBe("a=1");
	});

	test("print and println join their operands with no separator", () => {
		expect(capture('fmt := import("fmt")\nfmt.print("a", 1, true)')).toBe("a1true");
		expect(capture('fmt := import("fmt")\nfmt.println("a", "b")')).toBe("ab\n");
	});

	test("printf writes a formatted string without a newline", () => {
		expect(capture('fmt := import("fmt")\nfmt.printf("%d-%d", 1, 2)')).toBe("1-2");
	});

	test("print renders a string bare, where %v would quote it", () => {
		expect(capture('fmt := import("fmt")\nfmt.print("a")')).toBe("a");
		expect(capture('fmt := import("fmt")\nfmt.printf("%v", "a")')).toBe('"a"');
	});
});

describe("modules", () => {
	test("a module is an immutable map", () => {
		expect(ev("is_immutable_map(text)")).toBe(true);
		expect(ev("is_immutable_map(math)")).toBe(true);
		expect(() =>
			runFor('text := import("text")\ntext.split = 1\nout := 1', "out"),
		).toThrow(TengoError);
	});

	test("the same module imported twice is the same value", () => {
		expect(
			runFor('a := import("text")\nb := import("text")\nout := a == b', "out"),
		).toBe(true);
	});

	test("len counts a module's members", () => {
		expect(ev("len(math) > 50")).toBe(true);
		expect(ev("len(text) > 40")).toBe(true);
		expect(ev("len(fmt)")).toBe(4);
	});
});
