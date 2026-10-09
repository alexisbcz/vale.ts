/**
 * The handful of statistics the readability metrics need.
 *
 * These are small enough that depending on a statistics library for them costs
 * more than it saves.
 */

/** The arithmetic mean of `xs`, or NaN if `xs` is empty. */
export function mean(xs: readonly number[]): number {
	if (xs.length === 0) return Number.NaN;
	let sum = 0;
	for (const x of xs) sum += x;
	return sum / xs.length;
}

/**
 * The population standard deviation of `xs`, or NaN if `xs` is empty.
 *
 * Population rather than sample: readability formulas treat the text in hand
 * as the whole population, not a draw from a larger one.
 */
export function stdDev(xs: readonly number[]): number {
	if (xs.length === 0) return Number.NaN;
	const m = mean(xs);
	let variance = 0;
	for (const x of xs) variance += (x - m) * (x - m);
	return Math.sqrt(variance / xs.length);
}

/**
 * Rounds `x` to `places` decimals, with halves rounded away from zero.
 *
 * Not `Math.round` scaled up: that works to whole numbers only, and naively
 * scaling it changes which way exact halves go for negative input.
 */
export function round(x: number, places: number): number {
	if (Number.isNaN(x)) return Number.NaN;

	let sign = 1;
	let v = x;
	if (v < 0) {
		sign = -1;
		v = -v;
	}

	const precision = 10 ** places;
	const digit = v * precision;
	const decimal = digit - Math.trunc(digit);

	const rounded = decimal >= 0.5 ? Math.ceil(digit) : Math.floor(digit);

	return (rounded / precision) * sign;
}
