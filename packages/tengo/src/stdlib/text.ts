/**
 * The `text` module: Go's `strings` and `strconv` as Tengo exposes them, plus
 * the regular-expression functions a Vale `script` rule is mostly built out
 * of.
 *
 * # Regular expressions
 *
 * `re_match` and the rest go through `Regexp` from `@vale-ts/regex` rather
 * than a bare `RegExp`, because a rule author writes RE2: `(?s)` as an inline
 * flag, `\s` over Unicode space, a `$` that does not need `m` to behave. The
 * two script rules Vale ships both open with `(?s)`, so this is not a corner
 * case. `re_replace` expands `$1` and `${name}` in its replacement, which is
 * what Go's `Regexp.Expand` does and what `CamelToSnake.tengo` relies on.
 *
 * A pattern that will not compile is returned as an `error` value rather than
 * raised, which is how Tengo reports it -- the caller is expected to test it
 * with `is_error`.
 *
 * # Offsets
 *
 * Every index this module returns or takes is a JavaScript string index, not a
 * byte offset; see the note in `values.ts`. On ASCII, which is what index
 * arithmetic in a rule is written against, the two agree.
 */

import { Regexp } from "@vale-ts/regex";

import type { Value } from "../values.ts";
import {
	argInt,
	argStrictInt,
	argString,
	argTypeError,
	argValue,
	formatFloatF,
	makeArray,
	makeBool,
	makeBuiltin,
	makeError,
	makeFloat,
	makeInt,
	makeMap,
	makeString,
	ordinal,
	parseGoFloat,
	quoteGo,
	TengoError,
	toStringValue,
	typeName,
	UNDEFINED,
	wrongArgs,
} from "../values.ts";

/**
 * Compiled patterns, keyed by source.
 *
 * A script rule runs once per block and recompiles the same handful of
 * patterns each time; compiling is the expensive half of matching.
 */
const cache = new Map<string, Regexp>();

function compile(pattern: string): Regexp {
	const hit = cache.get(pattern);
	if (hit !== undefined) return hit;
	const re = Regexp.compile(pattern);
	cache.set(pattern, re);
	return re;
}

/** Runs `use` against a compiled pattern, or hands back an `error` value. */
function withPattern(pattern: string, use: (re: Regexp) => Value): Value {
	let re: Regexp;
	try {
		re = compile(pattern);
	} catch (err) {
		return makeError(makeString(err instanceof Error ? err.message : String(err)));
	}
	return use(re);
}

/** One `{text, begin, end}` map, as `re_find` reports a group. */
function submatch(text: string, begin: number, end: number): Value {
	return makeMap(
		new Map<string, Value>([
			["text", makeString(text)],
			["begin", makeInt(begin)],
			["end", makeInt(end)],
		]),
		true,
	);
}

/**
 * Up to `count` matches as Tengo reports them: an array per match, holding one
 * `{text, begin, end}` map per group that took part. A group that did not is
 * left out rather than reported empty, which is Tengo's shape -- so a rule
 * reading `m[1]` has to know its groups all matched.
 */
function findAll(re: Regexp, subject: string, count: number): Value | null {
	const matches = [...re.matches(subject, count)];
	if (matches.length === 0) return null;
	const out: Value[] = [];
	for (const m of matches) {
		const groups: Value[] = [];
		for (const [lo, hi] of m.spans) {
			if (lo < 0 || hi < 0) continue;
			groups.push(submatch(subject.slice(lo, hi), lo, hi));
		}
		out.push(makeArray(groups));
	}
	return makeArray(out);
}

/** A compiled pattern as a Tengo value, with the methods `re_compile` promises. */
function regexpValue(re: Regexp): Value {
	return makeMap(
		new Map<string, Value>([
			[
				"match",
				makeBuiltin("match", (args) => {
					if (args.length !== 1) throw wrongArgs();
					return makeBool(re.test(argString(args, 0)));
				}),
			],
			[
				"find",
				makeBuiltin("find", (args) => {
					if (args.length !== 1 && args.length !== 2) throw wrongArgs();
					const subject = argString(args, 0);
					const count = args.length === 2 ? argInt(args, 1) : 1;
					return findAll(re, subject, count) ?? UNDEFINED;
				}),
			],
			[
				"replace",
				makeBuiltin("replace", (args) => {
					if (args.length !== 2) throw wrongArgs();
					return makeString(re.replace(argString(args, 0), argString(args, 1)));
				}),
			],
			[
				"split",
				makeBuiltin("split", (args) => {
					if (args.length !== 1 && args.length !== 2) throw wrongArgs();
					const subject = argString(args, 0);
					const count = args.length === 2 ? argInt(args, 1) : -1;
					return makeArray(re.split(subject, count).map(makeString));
				}),
			],
		]),
		true,
	);
}

/** Go's `strings.Fields`: splits on runs of Unicode space. */
function fields(s: string): string[] {
	const out = s.split(/\s+/u).filter((part) => part.length > 0);
	return out;
}

/** Go's `strings.Replace` with a count; `n < 0` replaces every instance. */
function replaceN(s: string, from: string, to: string, n: number): string {
	if (n === 0 || from === to) return s;
	if (from === "") {
		// Go inserts the replacement between every rune, and before and after.
		const points = [...s];
		const limit = n < 0 ? points.length + 1 : Math.min(n, points.length + 1);
		let out = "";
		for (let i = 0; i < points.length + 1; i++) {
			if (i < limit) out += to;
			if (i < points.length) out += points[i];
		}
		return out;
	}

	let out = "";
	let at = 0;
	let done = 0;
	for (;;) {
		if (n >= 0 && done >= n) break;
		const found = s.indexOf(from, at);
		if (found < 0) break;
		out += s.slice(at, found) + to;
		at = found + from.length;
		done++;
	}
	return out + s.slice(at);
}

/** Go's `strings.SplitN` and `SplitAfterN`. */
function splitN(s: string, sep: string, n: number, after: boolean): string[] {
	if (n === 0) return [];
	if (sep === "") return [...s].slice(0, n < 0 ? undefined : n);

	const out: string[] = [];
	let at = 0;
	for (;;) {
		if (n > 0 && out.length === n - 1) break;
		const found = s.indexOf(sep, at);
		if (found < 0) break;
		out.push(after ? s.slice(at, found + sep.length) : s.slice(at, found));
		at = found + sep.length;
	}
	out.push(s.slice(at));
	return out;
}

/** Go's `strings.Trim` family: a cutset is a set of code points, not a prefix. */
function trimSet(s: string, cutset: string, left: boolean, right: boolean): string {
	const drop = new Set([...cutset]);
	let from = 0;
	let to = s.length;
	if (left) {
		while (from < to) {
			const cp = String.fromCodePoint(s.codePointAt(from) ?? 0);
			if (!drop.has(cp)) break;
			from += cp.length;
		}
	}
	if (right) {
		while (to > from) {
			// Step back over a possible surrogate pair.
			let start = to - 1;
			if (start > from && isLowSurrogate(s.charCodeAt(start))) start--;
			const cp = s.slice(start, to);
			if (!drop.has(cp)) break;
			to = start;
		}
	}
	return s.slice(from, to);
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Go's `strings.Title`: upper-cases the first letter of each word. */
function titleCase(s: string): string {
	let out = "";
	let atWordStart = true;
	for (const ch of s) {
		out += atWordStart ? ch.toUpperCase() : ch;
		atWordStart = !/[\p{L}\p{N}']/u.test(ch);
	}
	return out;
}

/** Go's `strings.IndexAny`, which reports a code-unit index. */
function indexAny(s: string, chars: string): number {
	const wanted = new Set([...chars]);
	for (let i = 0; i < s.length; ) {
		const cp = String.fromCodePoint(s.codePointAt(i) ?? 0);
		if (wanted.has(cp)) return i;
		i += cp.length;
	}
	return -1;
}

function lastIndexAny(s: string, chars: string): number {
	const wanted = new Set([...chars]);
	let found = -1;
	for (let i = 0; i < s.length; ) {
		const cp = String.fromCodePoint(s.codePointAt(i) ?? 0);
		if (wanted.has(cp)) found = i;
		i += cp.length;
	}
	return found;
}

/** Go's `strings.Count`, which counts the empty separator as runes plus one. */
function countOf(s: string, sub: string): number {
	if (sub === "") return [...s].length + 1;
	let n = 0;
	let at = 0;
	for (;;) {
		const found = s.indexOf(sub, at);
		if (found < 0) return n;
		n++;
		at = found + sub.length;
	}
}

/** Go's `padCount` rule, repeating the pad string and then slicing to width. */
function padTo(s: string, width: number, padWith: string, left: boolean): string {
	if (s.length >= width) return s;
	if (padWith.length === 0) return s;
	const count = Math.floor((width - padWith.length) / padWith.length) + 1;
	if (left) {
		const built = padWith.repeat(count) + s;
		return built.slice(built.length - width);
	}
	return (s + padWith.repeat(count)).slice(0, width);
}

/** Go's `strconv.FormatFloat`, for the `fmt` byte the module takes. */
function formatFloat(f: number, verb: string, prec: number): string {
	switch (verb) {
		case "f":
			return prec < 0 ? formatFloatF(f) : f.toFixed(Math.min(prec, 100));
		case "e":
		case "E": {
			const s = prec < 0 ? f.toExponential() : f.toExponential(Math.min(prec, 100));
			const fixed = s.replace(/e([+-])(\d)$/, "e$10$2");
			return verb === "E" ? fixed.toUpperCase() : fixed;
		}
		case "g":
		case "G": {
			const s = prec < 0 ? String(f) : f.toPrecision(Math.max(prec, 1));
			return verb === "G" ? s.toUpperCase() : s;
		}
		default:
			throw new TengoError(`unsupported float format ${JSON.stringify(verb)}`);
	}
}

/** Go's `strconv.Unquote` for the three literal forms it accepts. */
function unquoteGo(s: string): string | null {
	if (s.length < 2) return null;
	const open = s[0]!;
	const close = s[s.length - 1]!;
	if (open !== close) return null;
	const body = s.slice(1, -1);
	if (open === "`") return body.replaceAll("\r", "");
	if (open !== '"' && open !== "'") return null;

	let out = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		i++;
		const esc = body[i];
		switch (esc) {
			case "a":
				out += "\x07";
				break;
			case "b":
				out += "\b";
				break;
			case "f":
				out += "\f";
				break;
			case "n":
				out += "\n";
				break;
			case "r":
				out += "\r";
				break;
			case "t":
				out += "\t";
				break;
			case "v":
				out += "\v";
				break;
			case "\\":
				out += "\\";
				break;
			case '"':
				out += '"';
				break;
			case "'":
				out += "'";
				break;
			case "x":
			case "u":
			case "U": {
				const width = esc === "x" ? 2 : esc === "u" ? 4 : 8;
				const digits = body.slice(i + 1, i + 1 + width);
				if (digits.length !== width || !/^[0-9a-fA-F]+$/.test(digits)) return null;
				const code = Number.parseInt(digits, 16);
				out += width === 2 ? String.fromCharCode(code) : String.fromCodePoint(code);
				i += width;
				break;
			}
			default:
				return null;
		}
	}
	if (open === "'" && [...out].length !== 1) return null;
	return out;
}

/** The `text` module as `import("text")` sees it. */
export function textModule(): Value {
	const table = new Map<string, Value>();
	const def = (name: string, call: (args: Value[]) => Value): void => {
		table.set(name, makeBuiltin(name, call));
	};

	// --- regular expressions ---------------------------------------------

	def("re_match", (args) => {
		if (args.length !== 2) throw wrongArgs();
		const pattern = argString(args, 0);
		const subject = argString(args, 1);
		return withPattern(pattern, (re) => makeBool(re.test(subject)));
	});

	def("re_find", (args) => {
		if (args.length !== 2 && args.length !== 3) throw wrongArgs();
		const pattern = argString(args, 0);
		const subject = argString(args, 1);
		// With no count, Tengo reports the first match only, in the same
		// nested shape; there is no separate single-match form.
		const count = args.length === 3 ? argInt(args, 2) : 1;
		return withPattern(pattern, (re) => findAll(re, subject, count) ?? UNDEFINED);
	});

	def("re_replace", (args) => {
		if (args.length !== 3) throw wrongArgs();
		const pattern = argString(args, 0);
		const subject = argString(args, 1);
		const repl = argString(args, 2);
		return withPattern(pattern, (re) => makeString(re.replace(subject, repl)));
	});

	def("re_split", (args) => {
		if (args.length !== 2 && args.length !== 3) throw wrongArgs();
		const pattern = argString(args, 0);
		const subject = argString(args, 1);
		const count = args.length === 3 ? argInt(args, 2) : -1;
		return withPattern(pattern, (re) =>
			makeArray(re.split(subject, count).map(makeString)),
		);
	});

	def("re_compile", (args) => {
		if (args.length !== 1) throw wrongArgs();
		return withPattern(argString(args, 0), (re) => regexpValue(re));
	});

	// --- strings ----------------------------------------------------------

	def("compare", (args) => {
		const a = argString(args, 0);
		const b = argString(args, 1);
		return makeInt(a < b ? -1 : a > b ? 1 : 0);
	});
	def("contains", (args) =>
		makeBool(argString(args, 0).includes(argString(args, 1))),
	);
	def("contains_any", (args) =>
		makeBool(indexAny(argString(args, 0), argString(args, 1)) >= 0),
	);
	def("count", (args) => makeInt(countOf(argString(args, 0), argString(args, 1))));
	def("equal_fold", (args) => {
		const a = argString(args, 0);
		const b = argString(args, 1);
		return makeBool(a.toLowerCase() === b.toLowerCase());
	});
	def("fields", (args) => makeArray(fields(argString(args, 0)).map(makeString)));
	def("has_prefix", (args) =>
		makeBool(argString(args, 0).startsWith(argString(args, 1))),
	);
	def("has_suffix", (args) =>
		makeBool(argString(args, 0).endsWith(argString(args, 1))),
	);
	def("index", (args) => makeInt(argString(args, 0).indexOf(argString(args, 1))));
	def("index_any", (args) =>
		makeInt(indexAny(argString(args, 0), argString(args, 1))),
	);
	def("last_index", (args) =>
		makeInt(argString(args, 0).lastIndexOf(argString(args, 1))),
	);
	def("last_index_any", (args) =>
		makeInt(lastIndexAny(argString(args, 0), argString(args, 1))),
	);

	def("join", (args) => {
		if (args.length !== 2) throw wrongArgs();
		const first = argValue(args, 0);
		if (first.kind !== "array") throw argTypeError("first", "array", first);
		const parts = first.value.map((item, i) => {
			const s = toStringValue(item);
			if (s === null) {
				throw new TengoError(
					`invalid type for argument 'first[${i}]': expected string(compatible), found ${typeName(item)}`,
				);
			}
			return s;
		});
		return makeString(parts.join(argString(args, 1)));
	});

	def("repeat", (args) => {
		if (args.length !== 2) throw wrongArgs();
		const count = argInt(args, 1);
		if (count < 0) throw new TengoError("negative repeat count");
		return makeString(argString(args, 0).repeat(count));
	});

	def("replace", (args) => {
		if (args.length !== 4) throw wrongArgs();
		return makeString(
			replaceN(
				argString(args, 0),
				argString(args, 1),
				argString(args, 2),
				argInt(args, 3),
			),
		);
	});

	def("substr", (args) => {
		if (args.length !== 2 && args.length !== 3) throw wrongArgs();
		const s = argString(args, 0);
		let low = argInt(args, 1);
		let high = args.length === 3 ? argInt(args, 2) : s.length;
		if (low > high) throw new TengoError("invalid index type");
		low = Math.min(Math.max(low, 0), s.length);
		high = Math.min(Math.max(high, 0), s.length);
		return makeString(s.slice(low, high));
	});

	def("split", (args) =>
		makeArray(
			splitN(argString(args, 0), argString(args, 1), -1, false).map(makeString),
		),
	);
	def("split_after", (args) =>
		makeArray(
			splitN(argString(args, 0), argString(args, 1), -1, true).map(makeString),
		),
	);
	def("split_n", (args) =>
		makeArray(
			splitN(argString(args, 0), argString(args, 1), argInt(args, 2), false).map(
				makeString,
			),
		),
	);
	def("split_after_n", (args) =>
		makeArray(
			splitN(argString(args, 0), argString(args, 1), argInt(args, 2), true).map(
				makeString,
			),
		),
	);

	def("title", (args) => makeString(titleCase(argString(args, 0))));
	def("to_lower", (args) => makeString(argString(args, 0).toLowerCase()));
	def("to_title", (args) => makeString(argString(args, 0).toUpperCase()));
	def("to_upper", (args) => makeString(argString(args, 0).toUpperCase()));

	def("pad_left", (args) => {
		if (args.length !== 2 && args.length !== 3) throw wrongArgs();
		const pad = args.length === 3 ? argString(args, 2) : " ";
		return makeString(padTo(argString(args, 0), argInt(args, 1), pad, true));
	});
	def("pad_right", (args) => {
		if (args.length !== 2 && args.length !== 3) throw wrongArgs();
		const pad = args.length === 3 ? argString(args, 2) : " ";
		return makeString(padTo(argString(args, 0), argInt(args, 1), pad, false));
	});

	def("trim", (args) =>
		makeString(trimSet(argString(args, 0), argString(args, 1), true, true)),
	);
	def("trim_left", (args) =>
		makeString(trimSet(argString(args, 0), argString(args, 1), true, false)),
	);
	def("trim_right", (args) =>
		makeString(trimSet(argString(args, 0), argString(args, 1), false, true)),
	);
	def("trim_space", (args) => makeString(argString(args, 0).trim()));
	def("trim_prefix", (args) => {
		const s = argString(args, 0);
		const prefix = argString(args, 1);
		return makeString(s.startsWith(prefix) ? s.slice(prefix.length) : s);
	});
	def("trim_suffix", (args) => {
		const s = argString(args, 0);
		const suffix = argString(args, 1);
		return makeString(
			suffix.length > 0 && s.endsWith(suffix)
				? s.slice(0, s.length - suffix.length)
				: s,
		);
	});

	// --- strconv ----------------------------------------------------------

	def("atoi", (args) => {
		if (args.length !== 1) throw wrongArgs();
		const s = argString(args, 0);
		if (!/^[+-]?\d+$/.test(s)) {
			return makeError(
				makeString(`strconv.Atoi: parsing ${quoteGo(s)}: invalid syntax`),
			);
		}
		return makeInt(Number.parseInt(s, 10));
	});

	def("format_bool", (args) => {
		if (args.length !== 1) throw wrongArgs();
		const v = argValue(args, 0);
		if (v.kind !== "bool") throw argTypeError(ordinal(0), "bool", v);
		return makeString(v.value ? "true" : "false");
	});

	def("format_float", (args) => {
		if (args.length !== 4) throw wrongArgs();
		const v = argValue(args, 0);
		if (v.kind !== "float") throw argTypeError(ordinal(0), "float", v);
		const verb = argString(args, 1);
		return makeString(formatFloat(v.value, verb, argInt(args, 2)));
	});

	def("format_int", (args) => {
		if (args.length !== 2) throw wrongArgs();
		const v = argStrictInt(args, 0);
		const base = argInt(args, 1);
		if (base < 2 || base > 36) throw new TengoError("invalid base");
		return makeString(BigInt.asIntN(64, BigInt(v)).toString(base));
	});

	def("itoa", (args) => {
		if (args.length !== 1) throw wrongArgs();
		return makeString(String(argStrictInt(args, 0)));
	});

	def("parse_bool", (args) => {
		if (args.length !== 1) throw wrongArgs();
		const v = argValue(args, 0);
		if (v.kind !== "string") throw argTypeError(ordinal(0), "string", v);
		if (["1", "t", "T", "TRUE", "true", "True"].includes(v.value)) {
			return makeBool(true);
		}
		if (["0", "f", "F", "FALSE", "false", "False"].includes(v.value)) {
			return makeBool(false);
		}
		return makeError(
			makeString(`strconv.ParseBool: parsing ${quoteGo(v.value)}: invalid syntax`),
		);
	});

	def("parse_float", (args) => {
		if (args.length !== 2) throw wrongArgs();
		const v = argValue(args, 0);
		if (v.kind !== "string") throw argTypeError(ordinal(0), "string", v);
		const n = parseGoFloat(v.value);
		if (n === null) {
			return makeError(
				makeString(
					`strconv.ParseFloat: parsing ${quoteGo(v.value)}: invalid syntax`,
				),
			);
		}
		return makeFloat(n);
	});

	def("parse_int", (args) => {
		if (args.length !== 3) throw wrongArgs();
		const v = argValue(args, 0);
		if (v.kind !== "string") throw argTypeError(ordinal(0), "string", v);
		const base = argInt(args, 1);
		const n = parseGoInt(v.value, base);
		if (n === null) {
			return makeError(
				makeString(`strconv.ParseInt: parsing ${quoteGo(v.value)}: invalid syntax`),
			);
		}
		return makeInt(n);
	});

	def("quote", (args) => {
		if (args.length !== 1) throw wrongArgs();
		const v = argValue(args, 0);
		if (v.kind !== "string") throw argTypeError(ordinal(0), "string", v);
		return makeString(quoteGo(v.value));
	});

	def("unquote", (args) => {
		if (args.length !== 1) throw wrongArgs();
		const v = argValue(args, 0);
		if (v.kind !== "string") throw argTypeError(ordinal(0), "string", v);
		const out = unquoteGo(v.value);
		if (out === null) {
			return makeError(makeString("strconv.Unquote: invalid syntax"));
		}
		return makeString(out);
	});

	return makeMap(table, true);
}

/** Go's `strconv.ParseInt`, with base 0 reading the literal's own prefix. */
function parseGoInt(s: string, base: number): number | null {
	let body = s;
	let sign = 1;
	if (body.startsWith("+")) body = body.slice(1);
	else if (body.startsWith("-")) {
		sign = -1;
		body = body.slice(1);
	}
	let radix = base;
	if (base === 0) {
		if (/^0[xX]/.test(body)) {
			radix = 16;
			body = body.slice(2);
		} else if (/^0[oO]/.test(body)) {
			radix = 8;
			body = body.slice(2);
		} else if (/^0[bB]/.test(body)) {
			radix = 2;
			body = body.slice(2);
		} else if (body.length > 1 && body.startsWith("0")) {
			radix = 8;
			body = body.slice(1);
		} else {
			radix = 10;
		}
	}
	if (radix < 2 || radix > 36 || body.length === 0) return null;

	const digits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, radix);
	for (const ch of body.toLowerCase()) {
		if (!digits.includes(ch)) return null;
	}
	return sign * Number.parseInt(body, radix);
}
