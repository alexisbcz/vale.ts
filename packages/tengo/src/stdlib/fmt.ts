/**
 * The `fmt` module, and the formatter the `format` builtin shares with it.
 *
 * The verbs follow Tengo's `formatter.go`, which is a trimmed copy of Go's
 * `fmt`. Two places where that implementation and Tengo's own documentation
 * disagree are settled in favour of the implementation, because that is what a
 * style author's rule was tested against:
 *
 *   - `%v` renders the value's `String()`, so a float comes out in `%f` form
 *     rather than `%g`, and a string comes out quoted.
 *   - `%f`, `%e` and `%E` default to a precision of 6; `%g` and `%G` default
 *     to the shortest form that round-trips.
 *
 * `print` and `println` are the other way round: they render through
 * `ToString`, so a string comes out unquoted there.
 *
 * One deviation: rounding a value that falls exactly half way at the requested
 * precision goes away from zero here and to even in Go's `strconv`, so
 * `%.3e` of 1234.5 differs in the last digit. Only a value that is exactly
 * representable in binary can land on a tie, and nothing in Vale formats one.
 */

import type { Value } from "../values.ts";
import {
	argString,
	charText,
	display,
	formatFloatF,
	formatFloatG,
	makeBuiltin,
	makeMap,
	makeString,
	quoteGo,
	shortestDigits,
	toIntValue,
	toStringValue,
	typeName,
	UNDEFINED,
	wrongArgs,
} from "../values.ts";

/** The text `print` and `println` give a value: `ToString`, not `String()`. */
function printed(v: Value): string {
	return toStringValue(v) ?? "";
}

/**
 * Where `print`, `println` and `printf` write.
 *
 * A linter has no business writing to standard output mid-run, but `fmt` is
 * one of the three modules Vale allows and printing is what a style author
 * reaches for while debugging a rule. Keeping the sink replaceable lets a
 * caller route it somewhere else, and lets the tests read it back.
 */
let sink: (text: string) => void = (text) => {
	process.stdout.write(text);
};

export function setPrinter(fn: (text: string) => void): void {
	sink = fn;
}

interface Spec {
	plus: boolean;
	minus: boolean;
	sharp: boolean;
	space: boolean;
	zero: boolean;
	width: number | null;
	prec: number | null;
}

/** `format(f, ...)`: the formatted text of `args` under `f`. */
export function sprintf(format: string, args: Value[]): string {
	let out = "";
	let argIndex = 0;
	let i = 0;

	while (i < format.length) {
		const ch = format[i]!;
		if (ch !== "%") {
			out += ch;
			i++;
			continue;
		}

		i++;
		if (i >= format.length) {
			out += "%!(NOVERB)";
			break;
		}

		const spec: Spec = {
			plus: false,
			minus: false,
			sharp: false,
			space: false,
			zero: false,
			width: null,
			prec: null,
		};

		flags: for (; i < format.length; i++) {
			switch (format[i]) {
				case "+":
					spec.plus = true;
					break;
				case "-":
					spec.minus = true;
					break;
				case "#":
					spec.sharp = true;
					break;
				case " ":
					spec.space = true;
					break;
				case "0":
					spec.zero = true;
					break;
				default:
					break flags;
			}
		}

		if (format[i] === "*") {
			i++;
			spec.width = toIntValue(args[argIndex++] ?? UNDEFINED) ?? 0;
			if (spec.width < 0) {
				spec.minus = true;
				spec.width = -spec.width;
			}
		} else {
			const [n, read] = readNumber(format, i);
			if (n !== null) spec.width = n;
			i = read;
		}

		if (format[i] === ".") {
			i++;
			if (format[i] === "*") {
				i++;
				spec.prec = toIntValue(args[argIndex++] ?? UNDEFINED) ?? 0;
			} else {
				const [n, read] = readNumber(format, i);
				spec.prec = n ?? 0;
				i = read;
			}
		}

		const verb = format[i];
		if (verb === undefined) {
			out += "%!(NOVERB)";
			break;
		}
		i++;

		if (verb === "%") {
			out += "%";
			continue;
		}

		if (argIndex >= args.length) {
			out += `%!${verb}(MISSING)`;
			continue;
		}
		out += printArg(args[argIndex++]!, verb, spec);
	}

	if (argIndex < args.length) {
		const extra = args
			.slice(argIndex)
			.map((v) => `${typeName(v)}=${display(v)}`)
			.join(", ");
		out += `%!(EXTRA ${extra})`;
	}

	return out;
}

function readNumber(s: string, from: number): [number | null, number] {
	let i = from;
	while (i < s.length && s[i]! >= "0" && s[i]! <= "9") i++;
	if (i === from) return [null, from];
	return [Number.parseInt(s.slice(from, i), 10), i];
}

function printArg(v: Value, verb: string, spec: Spec): string {
	// %T and %v are answered before the type is looked at, as Tengo does.
	if (verb === "T") return padString(typeName(v), spec);
	if (verb === "v") {
		if (spec.sharp && v.kind === "string") return padString(quoteGo(v.value), spec);
		return padString(display(v), spec);
	}

	switch (v.kind) {
		case "bool":
			if (verb === "t") return padString(v.value ? "true" : "false", spec);
			return badVerb(v, verb);
		case "float":
			return formatFloatVerb(v.value, verb, spec) ?? badVerb(v, verb);
		case "int":
			return formatIntVerb(v.value, verb, spec) ?? badVerb(v, verb);
		case "string":
			return formatStringVerb(v.value, verb, spec) ?? badVerb(v, verb);
		case "bytes":
			return formatBytesVerb(v.value, verb, spec) ?? badVerb(v, verb);
		default:
			// Everything else renders through its text, which is what Tengo's
			// default branch does.
			return formatStringVerb(display(v), verb, spec) ?? badVerb(v, verb);
	}
}

function badVerb(v: Value, verb: string): string {
	return `%!${verb}(${typeName(v)}=${display(v)})`;
}

function formatStringVerb(s: string, verb: string, spec: Spec): string | null {
	switch (verb) {
		case "s":
			return padString(s, spec);
		case "q":
			return padString(quoteGo(s), spec);
		case "x":
		case "X":
			return padString(
				hexOf(new TextEncoder().encode(s), verb === "X", spec),
				spec,
			);
		default:
			return null;
	}
}

function formatBytesVerb(b: Uint8Array, verb: string, spec: Spec): string | null {
	switch (verb) {
		case "d":
			return padString(`[${[...b].join(" ")}]`, spec);
		case "s":
			return padString(new TextDecoder().decode(b), spec);
		case "x":
		case "X":
			return padString(hexOf(b, verb === "X", spec), spec);
		case "q":
			return padString(quoteGo(new TextDecoder().decode(b)), spec);
		default:
			return null;
	}
}

function hexOf(bytes: Uint8Array, upper: boolean, spec: Spec): string {
	const parts: string[] = [];
	for (const b of bytes) {
		const h = b.toString(16).padStart(2, "0");
		parts.push(upper ? h.toUpperCase() : h);
	}
	const joined = parts.join(spec.space ? " " : "");
	if (!spec.sharp) return joined;
	return (upper ? "0X" : "0x") + joined;
}

function formatIntVerb(n: number, verb: string, spec: Spec): string | null {
	switch (verb) {
		case "d":
			return padNumber(radix(n, 10), n < 0, "", spec);
		case "b":
			return padNumber(radix(n, 2), n < 0, spec.sharp ? "0b" : "", spec);
		case "o":
			return padNumber(radix(n, 8), n < 0, spec.sharp ? "0" : "", spec);
		case "O":
			return padNumber(radix(n, 8), n < 0, "0o", spec);
		case "x":
			return padNumber(radix(n, 16), n < 0, spec.sharp ? "0x" : "", spec);
		case "X":
			return padNumber(
				radix(n, 16).toUpperCase(),
				n < 0,
				spec.sharp ? "0X" : "",
				spec,
			);
		case "c":
			return padString(charText(n), spec);
		case "q":
			return padString(quoteChar(n), spec);
		case "U": {
			const hex = n.toString(16).toUpperCase().padStart(4, "0");
			const base = `U+${hex}`;
			return padString(spec.sharp ? `${base} '${charText(n)}'` : base, spec);
		}
		default:
			return null;
	}
}

/** The digits of `n` in `base`, without a sign, wrapped to 64 bits. */
function radix(n: number, base: number): string {
	const wrapped = BigInt.asIntN(64, BigInt(Math.trunc(n)));
	const abs = wrapped < 0n ? -wrapped : wrapped;
	return abs.toString(base);
}

function quoteChar(code: number): string {
	const text = charText(code);
	if (text === "'") return "'\\''";
	if (text === "\\") return "'\\\\'";
	const quoted = quoteGo(text);
	return `'${quoted.slice(1, -1)}'`;
}

function formatFloatVerb(v: number, verb: string, spec: Spec): string | null {
	let body: string;
	switch (verb) {
		case "f":
		case "F":
			body = fixed(Math.abs(v), spec.prec ?? 6);
			break;
		case "e":
		case "E":
			body = scientific(Math.abs(v), spec.prec ?? 6, verb === "E");
			break;
		case "g":
		case "G": {
			body = general(Math.abs(v), spec.prec);
			if (verb === "G") body = body.toUpperCase();
			break;
		}
		default:
			return null;
	}

	if (!Number.isFinite(v)) {
		body = Number.isNaN(v) ? "NaN" : "Inf";
		return padString((v < 0 ? "-" : spec.plus ? "+" : "") + body, spec);
	}
	return padNumber(body, v < 0 || Object.is(v, -0), "", spec);
}

function fixed(abs: number, prec: number): string {
	// toFixed tops out at 100 digits and switches to exponent form above 1e21,
	// so very large values are expanded from the plain form instead.
	if (abs >= 1e21) {
		const whole = formatFloatF(abs);
		return prec > 0 ? `${whole}.${"0".repeat(prec)}` : whole;
	}
	return abs.toFixed(Math.min(prec, 100));
}

function scientific(abs: number, prec: number, upper: boolean): string {
	const s = abs.toExponential(Math.min(prec, 100));
	const e = s.indexOf("e");
	const mantissa = s.slice(0, e);
	const exp = Number.parseInt(s.slice(e + 1), 10);
	const sign = exp < 0 ? "-" : "+";
	const mag = Math.abs(exp).toString().padStart(2, "0");
	return `${mantissa}${upper ? "E" : "e"}${sign}${mag}`;
}

/**
 * `%g`: `%e` when the decimal exponent falls outside the range the precision
 * allows, `%f` otherwise. With no precision the shortest round-tripping form
 * is used and the cutoff is Go's fixed 6.
 */
function general(abs: number, prec: number | null): string {
	if (prec === null) return formatFloatG(abs);

	const digits = prec === 0 ? 1 : prec;
	const { exp } = shortestDigits(abs === 0 ? 0 : abs);
	if (abs !== 0 && (exp < -4 || exp >= digits)) {
		return trimZeros(scientific(abs, digits - 1, false), true);
	}
	const places = Math.max(digits - 1 - (abs === 0 ? 0 : exp), 0);
	return trimZeros(abs.toFixed(Math.min(places, 100)), false);
}

function trimZeros(s: string, scientificForm: boolean): string {
	if (scientificForm) {
		const e = s.indexOf("e");
		const mantissa = trimZeros(s.slice(0, e), false);
		return mantissa + s.slice(e);
	}
	if (!s.includes(".")) return s;
	return s.replace(/\.?0+$/, "");
}

function padString(s: string, spec: Spec): string {
	let text = s;
	if (spec.prec !== null) {
		const points = [...text];
		if (points.length > spec.prec) text = points.slice(0, spec.prec).join("");
	}
	return pad(text, spec);
}

/** Pads a number, keeping any sign or prefix ahead of the zero padding. */
function padNumber(
	digits: string,
	negative: boolean,
	prefix: string,
	spec: Spec,
): string {
	let body = digits;
	if (spec.prec !== null && body.length < spec.prec) {
		body = "0".repeat(spec.prec - body.length) + body;
	}
	const sign = negative ? "-" : spec.plus ? "+" : spec.space ? " " : "";
	const head = sign + prefix;

	if (
		spec.zero &&
		!spec.minus &&
		spec.width !== null &&
		head.length + body.length < spec.width
	) {
		body = "0".repeat(spec.width - head.length - body.length) + body;
	}
	return pad(head + body, spec);
}

function pad(text: string, spec: Spec): string {
	const width = spec.width;
	if (width === null) return text;
	const points = [...text];
	if (points.length >= width) return text;
	const fill = " ".repeat(width - points.length);
	return spec.minus ? text + fill : fill + text;
}

/** The `fmt` module as `import("fmt")` sees it. */
export function fmtModule(): Value {
	const entries = new Map<string, Value>([
		[
			"print",
			makeBuiltin("print", (args) => {
				sink(args.map(printed).join(""));
				return UNDEFINED;
			}),
		],
		[
			"println",
			makeBuiltin("println", (args) => {
				sink(`${args.map(printed).join("")}\n`);
				return UNDEFINED;
			}),
		],
		[
			"printf",
			makeBuiltin("printf", (args) => {
				if (args.length === 0) throw wrongArgs();
				sink(sprintf(argString(args, 0), args.slice(1)));
				return UNDEFINED;
			}),
		],
		[
			"sprintf",
			makeBuiltin("sprintf", (args) => {
				if (args.length === 0) throw wrongArgs();
				return makeString(sprintf(argString(args, 0), args.slice(1)));
			}),
		],
	]);
	return makeMap(entries, true);
}
