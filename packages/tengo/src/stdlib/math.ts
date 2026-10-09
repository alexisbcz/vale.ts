/**
 * The `math` module: Go's `math` package as Tengo exposes it.
 *
 * Every function takes floats and returns a float, except `ilogb` (int),
 * `is_inf`, `is_nan` and `signbit` (bool), and `inf`, `pow10`, `jn` and `yn`,
 * whose first argument is an int. An argument is converted, not type-checked,
 * so `math.sqrt(4)` is as valid as `math.sqrt(4.0)` -- which matters, because
 * `SMOG.yml` writes `math.sqrt((polysyllabic_words * 30.0) / sentences)`.
 *
 * `erf`, `erfc`, `gamma` and the Bessel family have no counterpart in
 * JavaScript, so they are computed from the standard rational and series
 * approximations. They are accurate to roughly a part in 10^8 rather than to
 * the last bit, which Go's are; no readability formula calls any of them, and
 * a rule that does gets a usable answer instead of a missing function.
 */

import type { Value } from "../values.ts";
import {
	argFloat,
	argInt,
	makeBool,
	makeBuiltin,
	makeFloat,
	makeInt,
	makeMap,
	wrongArgs,
} from "../values.ts";

/** The `math` module as `import("math")` sees it. */
export function mathModule(): Value {
	const table = new Map<string, Value>();

	const constant = (name: string, value: number): void => {
		table.set(name, makeFloat(value));
	};
	const intConstant = (name: string, value: number): void => {
		table.set(name, makeInt(value));
	};

	constant("e", Math.E);
	constant("pi", Math.PI);
	constant("phi", (1 + Math.sqrt(5)) / 2);
	constant("sqrt2", Math.SQRT2);
	constant("sqrtE", Math.sqrt(Math.E));
	constant("sqrtPi", Math.sqrt(Math.PI));
	constant("sqrtPhi", Math.sqrt((1 + Math.sqrt(5)) / 2));
	constant("ln2", Math.LN2);
	constant("log2E", 1 / Math.LN2);
	constant("ln10", Math.LN10);
	constant("log10E", 1 / Math.LN10);

	constant("maxFloat32", 3.4028234663852886e38);
	constant("smallestNonzeroFloat32", 1.401298464324817e-45);
	constant("maxFloat64", Number.MAX_VALUE);
	constant("smallestNonzeroFloat64", 5e-324);

	// Go's int is 64 bits wide, so maxInt and maxInt64 agree. Both exceed what
	// a double represents exactly; they round, as they would anywhere else in
	// this port, which is why they are spelled as powers rather than as
	// literals a reader would expect to be exact.
	intConstant("maxInt", 2 ** 63 - 1);
	intConstant("minInt", -(2 ** 63));
	intConstant("maxInt8", 127);
	intConstant("minInt8", -128);
	intConstant("maxInt16", 32767);
	intConstant("minInt16", -32768);
	intConstant("maxInt32", 2147483647);
	intConstant("minInt32", -2147483648);
	intConstant("maxInt64", 2 ** 63 - 1);
	intConstant("minInt64", -(2 ** 63));

	/** A function over one float, returning a float. */
	const f1 = (name: string, fn: (x: number) => number): void => {
		table.set(
			name,
			makeBuiltin(name, (args) => {
				if (args.length !== 1) throw wrongArgs();
				return makeFloat(fn(argFloat(args, 0)));
			}),
		);
	};

	/** A function over two floats, returning a float. */
	const f2 = (name: string, fn: (x: number, y: number) => number): void => {
		table.set(
			name,
			makeBuiltin(name, (args) => {
				if (args.length !== 2) throw wrongArgs();
				return makeFloat(fn(argFloat(args, 0), argFloat(args, 1)));
			}),
		);
	};

	f1("abs", Math.abs);
	f1("acos", Math.acos);
	f1("acosh", Math.acosh);
	f1("asin", Math.asin);
	f1("asinh", Math.asinh);
	f1("atan", Math.atan);
	f2("atan2", Math.atan2);
	f1("atanh", Math.atanh);
	f1("cbrt", Math.cbrt);
	f1("ceil", Math.ceil);
	f2("copysign", (x, y) =>
		y < 0 || Object.is(y, -0) ? -Math.abs(x) : Math.abs(x),
	);
	f1("cos", Math.cos);
	f1("cosh", Math.cosh);
	f2("dim", (x, y) => Math.max(x - y, 0));
	f1("erf", erf);
	f1("erfc", (x) => 1 - erf(x));
	f1("exp", Math.exp);
	f1("exp2", (x) => 2 ** x);
	f1("expm1", Math.expm1);
	f1("floor", Math.floor);
	f1("gamma", gamma);
	f2("hypot", Math.hypot);
	f1("log", Math.log);
	f1("log10", Math.log10);
	f1("log1p", Math.log1p);
	f1("log2", Math.log2);
	f1("logb", (x) => Math.floor(Math.log2(Math.abs(x))));
	f2("max", Math.max);
	f2("min", Math.min);
	f2("mod", (x, y) => x % y);
	f2("nextafter", nextAfter);
	f2("pow", (x, y) => x ** y);
	f2("remainder", remainder);
	f1("sin", Math.sin);
	f1("sinh", Math.sinh);
	f1("sqrt", Math.sqrt);
	f1("tan", Math.tan);
	f1("tanh", Math.tanh);
	f1("trunc", Math.trunc);
	f1("j0", (x) => besselJ(0, x));
	f1("j1", (x) => besselJ(1, x));
	f1("y0", (x) => besselY(0, x));
	f1("y1", (x) => besselY(1, x));

	table.set(
		"ilogb",
		makeBuiltin("ilogb", (args) => {
			if (args.length !== 1) throw wrongArgs();
			return makeInt(Math.floor(Math.log2(Math.abs(argFloat(args, 0)))));
		}),
	);

	table.set(
		"inf",
		makeBuiltin("inf", (args) => {
			if (args.length !== 1) throw wrongArgs();
			return makeFloat(
				argInt(args, 0) >= 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
			);
		}),
	);

	table.set(
		"nan",
		makeBuiltin("nan", (args) => {
			if (args.length !== 0) throw wrongArgs();
			return makeFloat(Number.NaN);
		}),
	);

	table.set(
		"is_inf",
		makeBuiltin("is_inf", (args) => {
			if (args.length !== 2) throw wrongArgs();
			const x = argFloat(args, 0);
			const sign = argInt(args, 1);
			if (sign > 0) return makeBool(x === Number.POSITIVE_INFINITY);
			if (sign < 0) return makeBool(x === Number.NEGATIVE_INFINITY);
			return makeBool(!Number.isFinite(x) && !Number.isNaN(x));
		}),
	);

	table.set(
		"is_nan",
		makeBuiltin("is_nan", (args) => {
			if (args.length !== 1) throw wrongArgs();
			return makeBool(Number.isNaN(argFloat(args, 0)));
		}),
	);

	table.set(
		"signbit",
		makeBuiltin("signbit", (args) => {
			if (args.length !== 1) throw wrongArgs();
			const x = argFloat(args, 0);
			return makeBool(x < 0 || Object.is(x, -0));
		}),
	);

	table.set(
		"ldexp",
		makeBuiltin("ldexp", (args) => {
			if (args.length !== 2) throw wrongArgs();
			return makeFloat(argFloat(args, 0) * 2 ** argInt(args, 1));
		}),
	);

	table.set(
		"pow10",
		makeBuiltin("pow10", (args) => {
			if (args.length !== 1) throw wrongArgs();
			return makeFloat(10 ** argInt(args, 0));
		}),
	);

	table.set(
		"jn",
		makeBuiltin("jn", (args) => {
			if (args.length !== 2) throw wrongArgs();
			return makeFloat(besselJ(argInt(args, 0), argFloat(args, 1)));
		}),
	);

	table.set(
		"yn",
		makeBuiltin("yn", (args) => {
			if (args.length !== 2) throw wrongArgs();
			return makeFloat(besselY(argInt(args, 0), argFloat(args, 1)));
		}),
	);

	return makeMap(table, true);
}

/** IEEE 754's remainder, which rounds the quotient to the nearest even. */
function remainder(x: number, y: number): number {
	if (!Number.isFinite(x) || Number.isNaN(y) || y === 0) return Number.NaN;
	if (!Number.isFinite(y)) return x;
	const q = x / y;
	let n = Math.round(q);
	// Math.round breaks a tie upwards; IEEE breaks it to even.
	if (Math.abs(q - Math.trunc(q)) === 0.5 && n % 2 !== 0) n -= Math.sign(q) || 1;
	return x - n * y;
}

/** The next representable double after `x` in the direction of `y`. */
function nextAfter(x: number, y: number): number {
	if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
	if (x === y) return y;
	if (x === 0) return y > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;

	const buf = new DataView(new ArrayBuffer(8));
	buf.setFloat64(0, x);
	let bits = buf.getBigUint64(0);
	// Stepping the bit pattern walks the representable values in order, away
	// from zero for a positive sign and towards it for a negative one.
	bits += y > x === x > 0 ? 1n : -1n;
	buf.setBigUint64(0, bits);
	return buf.getFloat64(0);
}

/**
 * The error function, from the rational approximation in Numerical Recipes
 * (`erfc` by continued fraction), good to about 1.2e-7 relative.
 */
function erf(x: number): number {
	const z = Math.abs(x);
	const t = 1 / (1 + z / 2);
	const poly =
		-1.26551223 +
		t *
			(1.00002368 +
				t *
					(0.37409196 +
						t *
							(0.09678418 +
								t *
									(-0.18628806 +
										t *
											(0.27886807 +
												t *
													(-1.13520398 +
														t *
															(1.48851587 +
																t * (-0.82215223 + t * 0.17087277))))))));
	const erfc = t * Math.exp(-z * z + poly);
	return x >= 0 ? 1 - erfc : erfc - 1;
}

const LANCZOS = [
	676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
	12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
	1.5056327351493116e-7,
];

/** The gamma function, by the Lanczos approximation with g = 7, n = 9. */
function gamma(x: number): number {
	if (Number.isNaN(x)) return Number.NaN;
	if (x === Number.POSITIVE_INFINITY) return x;
	if (Number.isInteger(x) && x <= 0) return Number.NaN;

	if (x < 0.5) {
		// Reflect, since the series converges only to the right of 1/2.
		return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
	}

	const z = x - 1;
	let sum = 0.99999999999980993;
	for (let i = 0; i < LANCZOS.length; i++) sum += LANCZOS[i]! / (z + i + 1);
	const t = z + LANCZOS.length - 0.5;
	return Math.sqrt(2 * Math.PI) * t ** (z + 0.5) * Math.exp(-t) * sum;
}

/**
 * Bessel functions of the first and second kind.
 *
 * `j0`, `j1`, `y0` and `y1` come from the Numerical Recipes polynomial
 * approximations; higher orders are built up from them, downwards by Miller's
 * backward recurrence for `jn` (the upward one is unstable there) and upwards
 * for `yn`.
 */
function besselJ(n: number, x: number): number {
	if (n < 0) return (n % 2 === 0 ? 1 : -1) * besselJ(-n, x);
	if (n === 0) return j0(x);
	if (n === 1) return j1(x);

	const ax = Math.abs(x);
	if (ax === 0) return 0;

	const twoOverX = 2 / ax;
	let out: number;
	if (ax > n) {
		// Forward recurrence is stable once x exceeds the order.
		let prev = j0(ax);
		let cur = j1(ax);
		for (let i = 1; i < n; i++) {
			const next = i * twoOverX * cur - prev;
			prev = cur;
			cur = next;
		}
		out = cur;
	} else {
		// Miller's downward recurrence, started well above the wanted order
		// and renormalised against the known sum of the even-order terms.
		const start = 2 * Math.floor((n + Math.floor(Math.sqrt(40 * n))) / 2);
		let sum = 0;
		let ans = 0;
		let prev = 0;
		let cur = 1;
		let adding = false;
		for (let j = start; j > 0; j--) {
			const next = j * twoOverX * cur - prev;
			prev = cur;
			cur = next;
			if (Math.abs(cur) > 1e10) {
				cur *= 1e-10;
				prev *= 1e-10;
				ans *= 1e-10;
				sum *= 1e-10;
			}
			if (adding) sum += cur;
			adding = !adding;
			if (j === n) ans = prev;
		}
		out = ans / (2 * sum - cur);
	}

	return x < 0 && n % 2 === 1 ? -out : out;
}

function besselY(n: number, x: number): number {
	if (x <= 0) return Number.NaN;
	if (n === 0) return y0(x);
	if (n === 1) return y1(x);

	const twoOverX = 2 / x;
	let prev = y0(x);
	let cur = y1(x);
	for (let i = 1; i < n; i++) {
		const next = i * twoOverX * cur - prev;
		prev = cur;
		cur = next;
	}
	return cur;
}

function j0(x: number): number {
	const ax = Math.abs(x);
	if (ax < 8) {
		const y = x * x;
		const num =
			57568490574 +
			y *
				(-13362590354 +
					y *
						(651619640.7 +
							y * (-11214424.18 + y * (77392.33017 + y * -184.9052456))));
		const den =
			57568490411 +
			y *
				(1029532985 +
					y * (9494680.718 + y * (59272.64853 + y * (267.8532712 + y))));
		return num / den;
	}
	const z = 8 / ax;
	const y = z * z;
	const xx = ax - 0.785398164;
	const p =
		1 +
		y *
			(-0.1098628627e-2 +
				y * (0.2734510407e-4 + y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
	const q =
		-0.1562499995e-1 +
		y *
			(0.1430488765e-3 +
				y * (-0.6911147651e-5 + y * (0.7621095161e-6 + y * -0.934935152e-7)));
	return Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q);
}

function j1(x: number): number {
	const ax = Math.abs(x);
	if (ax < 8) {
		const y = x * x;
		const num =
			x *
			(72362614232 +
				y *
					(-7895059235 +
						y *
							(242396853.1 +
								y * (-2972611.439 + y * (15704.4826 + y * -30.16036606)))));
		const den =
			144725228442 +
			y *
				(2300535178 +
					y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
		return num / den;
	}
	const z = 8 / ax;
	const y = z * z;
	const xx = ax - 2.356194491;
	const p =
		1 +
		y *
			(0.183105e-2 +
				y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)));
	const q =
		0.04687499995 +
		y *
			(-0.2002690873e-3 +
				y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
	const out =
		Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q);
	return x < 0 ? -out : out;
}

function y0(x: number): number {
	if (x < 8) {
		const y = x * x;
		const num =
			-2957821389 +
			y *
				(7062834065 +
					y *
						(-512359803.6 +
							y * (10879881.29 + y * (-86327.92757 + y * 228.4622733))));
		const den =
			40076544269 +
			y *
				(745249964.8 +
					y * (7189466.438 + y * (47447.2647 + y * (226.1030244 + y))));
		return num / den + 0.636619772 * j0(x) * Math.log(x);
	}
	const z = 8 / x;
	const y = z * z;
	const xx = x - 0.785398164;
	const p =
		1 +
		y *
			(-0.1098628627e-2 +
				y * (0.2734510407e-4 + y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
	const q =
		-0.1562499995e-1 +
		y *
			(0.1430488765e-3 +
				y * (-0.6911147651e-5 + y * (0.7621095161e-6 + y * -0.934935152e-7)));
	return Math.sqrt(0.636619772 / x) * (Math.sin(xx) * p + z * Math.cos(xx) * q);
}

function y1(x: number): number {
	if (x < 8) {
		const y = x * x;
		const num =
			x *
			(-0.4900604943e13 +
				y *
					(0.127527439e13 +
						y *
							(-0.5153438139e11 +
								y *
									(0.7349264551e9 + y * (-0.4237922726e7 + y * 0.8511937935e4)))));
		const den =
			0.249958057e14 +
			y *
				(0.4244419664e12 +
					y * (0.3733650367e10 + y * (0.2245904002e8 + y * (0.102042605e6 + y))));
		return num / den + 0.636619772 * (j1(x) * Math.log(x) - 1 / x);
	}
	const z = 8 / x;
	const y = z * z;
	const xx = x - 2.356194491;
	const p =
		1 +
		y *
			(0.183105e-2 +
				y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)));
	const q =
		0.04687499995 +
		y *
			(-0.2002690873e-3 +
				y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
	return Math.sqrt(0.636619772 / x) * (Math.sin(xx) * p + z * Math.cos(xx) * q);
}
