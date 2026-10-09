/**
 * The text transformations an `edit` action applies, and the group references
 * its arguments may hold.
 *
 * Each one is a pure function of a string, so a pipeline of them is a fold.
 * They are kept apart from `action.ts` because the table there is about
 * dispatch and arity, and these are about the text.
 */

const SPACE_RUNS = /\s+/g;
const GROUP_REF = /\$(\$|\d+|\{\d+\})/g;
const CARDINAL = /^-?\d+$/;
const ORDINAL_RE = /^(\d+)(st|nd|rd|th)$/i;

/**
 * Fills `$N` references in an argument from the match and its token's capture
 * groups: `$0` is the whole match, `$1` the first group, `$$` a dollar sign.
 *
 * A reference past the last group expands to nothing rather than staying as
 * written, so a rule whose token matched a branch with fewer groups does not
 * leak `$2` into the suggestion.
 */
export function expandGroups(
	arg: string,
	match: string,
	groups: readonly string[] | undefined,
): string {
	if (!arg.includes("$")) return arg;
	const g = groups ?? [];
	return arg.replace(GROUP_REF, (ref) => {
		const body = ref.slice(1).replace(/[{}]/g, "");
		if (body === "$") return "$";
		const n = Number.parseInt(body, 10);
		if (!Number.isFinite(n) || n === 0) return match;
		if (n <= g.length) return g[n - 1]!;
		return "";
	});
}

/** Collapses every run of whitespace into one space. */
export function squeeze(s: string): string {
	return s.replace(SPACE_RUNS, " ");
}

export function capitalize(s: string): string {
	const cp = s.codePointAt(0);
	if (cp === undefined) return s;
	const first = String.fromCodePoint(cp);
	return first.toUpperCase() + s.slice(first.length);
}

export function uncapitalize(s: string): string {
	const cp = s.codePointAt(0);
	if (cp === undefined) return s;
	const first = String.fromCodePoint(cp);
	return first.toLowerCase() + s.slice(first.length);
}

/**
 * Turns typewriter punctuation into its typographic form: `---` and `--` into
 * dashes, `...` into an ellipsis, and straight quotes into curly ones --
 * opening after whitespace or a bracket, closing otherwise.
 */
export function smartPunctuation(s: string): string {
	let t = s.replaceAll("---", "—");
	t = t.replaceAll("--", "–");
	t = t.replaceAll("...", "…");

	let out = "";
	let prev = "";
	let i = 0;
	for (const r of t) {
		if (r === '"') out += i === 0 || opensQuote(prev) ? "“" : "”";
		else if (r === "'") out += i === 0 || opensQuote(prev) ? "‘" : "’";
		else out += r;
		prev = r;
		i += r.length;
	}
	return out;
}

function opensQuote(prev: string): boolean {
	if (prev === "") return false;
	return /\s/u.test(prev) || "([{<—–/".includes(prev);
}

const DUMB: ReadonlyArray<readonly [string, string]> = [
	["‘", "'"],
	["’", "'"],
	["“", '"'],
	["”", '"'],
	["—", "---"],
	["–", "--"],
	["…", "..."],
	[" ", " "],
];

/** The inverse of `smartPunctuation`. */
export function dumbPunctuation(s: string): string {
	let out = s;
	for (const [from, to] of DUMB) out = out.replaceAll(from, to);
	return out;
}

/** The letters that have no base form to strip an accent from. */
const ASCII_LETTERS: ReadonlyArray<readonly [string, string]> = [
	["æ", "ae"],
	["Æ", "AE"],
	["œ", "oe"],
	["Œ", "OE"],
	["ß", "ss"],
	["ø", "o"],
	["Ø", "O"],
	["đ", "d"],
	["Đ", "D"],
	["ł", "l"],
	["Ł", "L"],
	["þ", "th"],
	["Þ", "Th"],
	["ð", "d"],
	["Ð", "D"],
];

/**
 * Strips accents, spells out the letters that have no base form, and
 * straightens punctuation.
 *
 * Decomposing and dropping the combining marks is what Go's
 * `norm.NFD`/`runes.Remove` chain does; `normalize("NFD")` plus a
 * `\p{Mn}` filter is the same operation.
 */
export function toASCII(s: string): string {
	let out = dumbPunctuation(s);
	for (const [from, to] of ASCII_LETTERS) out = out.replaceAll(from, to);
	return out
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.normalize("NFC");
}

const ONES = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen",
];
const TENS = [
	"",
	"",
	"twenty",
	"thirty",
	"forty",
	"fifty",
	"sixty",
	"seventy",
	"eighty",
	"ninety",
];
const SCALES: ReadonlyArray<readonly [bigint, string]> = [
	[1_000_000_000_000n, "trillion"],
	[1_000_000_000n, "billion"],
	[1_000_000n, "million"],
	[1_000n, "thousand"],
];
const IRREGULAR_ORDINALS: Record<string, string> = {
	one: "first",
	two: "second",
	three: "third",
	five: "fifth",
	eight: "eighth",
	nine: "ninth",
	twelve: "twelfth",
};

/**
 * An integer spelled out.
 *
 * Counted in `bigint` because Go counts in `int64`: a trillion-scale value is
 * within a double's exact range, but the remainders are taken with `%`, and
 * doing that in floating point invites a rounding difference the Go code
 * cannot have.
 */
export function cardinalWords(value: bigint): string {
	const n = value;
	if (n < 0n) return `minus ${cardinalWords(-n)}`;
	if (n < 20n) return ONES[Number(n)]!;
	if (n < 100n) {
		let s = TENS[Number(n / 10n)]!;
		if (n % 10n !== 0n) s += `-${ONES[Number(n % 10n)]}`;
		return s;
	}
	if (n < 1000n) {
		let s = `${ONES[Number(n / 100n)]} hundred`;
		if (n % 100n !== 0n) s += ` ${cardinalWords(n % 100n)}`;
		return s;
	}

	for (const [value_, name] of SCALES) {
		if (n >= value_) {
			let s = `${cardinalWords(n / value_)} ${name}`;
			const rem = n % value_;
			if (rem !== 0n) s += ` ${cardinalWords(rem)}`;
			return s;
		}
	}
	return n.toString();
}

/** The ordinal form of the last word of a spelled-out number. */
export function ordinalWord(word: string): string {
	const irregular = IRREGULAR_ORDINALS[word];
	if (irregular !== undefined) return irregular;
	if (word.endsWith("y")) return `${word.slice(0, -1)}ieth`;
	return `${word}th`;
}

export function ordinalWords(n: bigint): string {
	const s = cardinalWords(n);
	let i = -1;
	for (let k = s.length - 1; k >= 0; k--) {
		if (s[k] === " " || s[k] === "-") {
			i = k;
			break;
		}
	}
	return s.slice(0, i + 1) + ordinalWord(s.slice(i + 1));
}

/**
 * Spells out an integer or an ordinal, `21` or `21st`, and leaves anything
 * else as written.
 */
export function numberToWords(s: string): string {
	const plain = s.replaceAll(",", "");

	if (CARDINAL.test(plain)) {
		try {
			return cardinalWords(BigInt(plain));
		} catch {
			return s;
		}
	}
	const m = ORDINAL_RE.exec(plain);
	if (m !== null) {
		try {
			return ordinalWords(BigInt(m[1]!));
		} catch {
			return s;
		}
	}
	return s;
}

interface NumberWord {
	value: bigint;
	ordinal: boolean;
}

/** Every word `numberToWords` can produce, with its value. */
const NUMBER_WORDS: Map<string, NumberWord> = (() => {
	const words = new Map<string, NumberWord>();
	const add = (word: string, value: bigint): void => {
		words.set(word, { value, ordinal: false });
		words.set(ordinalWord(word), { value, ordinal: true });
	};
	for (let i = 0; i < ONES.length; i++) add(ONES[i]!, BigInt(i));
	for (let i = 0; i < TENS.length; i++) {
		if (TENS[i] !== "") add(TENS[i]!, BigInt(i * 10));
	}
	add("hundred", 100n);
	for (const [value, name] of SCALES) add(name, value);
	return words;
})();

/** Reads a spelled-out integer or ordinal back into digits. */
export function wordsToNumber(s: string): string {
	const fields = s
		.toLowerCase()
		.split(/[ -]/)
		.filter((f) => f !== "");
	if (fields.length === 0) return s;

	let total = 0n;
	let current = 0n;
	let negative = false;
	let ordinal = false;

	for (let i = 0; i < fields.length; i++) {
		const field = fields[i]!;
		if (field === "and") continue;
		if (field === "minus" && i === 0) {
			negative = true;
			continue;
		}

		const word = NUMBER_WORDS.get(field);
		if (word === undefined || (ordinal && !word.ordinal)) return s;
		if (word.ordinal) {
			if (i !== fields.length - 1) return s;
			ordinal = true;
		}

		if (word.value === 100n) {
			if (current === 0n) current = 1n;
			current *= 100n;
		} else if (word.value >= 1000n) {
			if (current === 0n) current = 1n;
			total += current * word.value;
			current = 0n;
		} else {
			current += word.value;
		}
	}

	let n = total + current;
	if (negative) n = -n;

	let out = n.toString();
	if (ordinal) out += ordinalSuffix(n);
	return out;
}

export function ordinalSuffix(value: bigint): string {
	const n = value < 0n ? -value : value;
	const hundred = n % 100n;
	if (hundred >= 11n && hundred <= 13n) return "th";
	switch (n % 10n) {
		case 1n:
			return "st";
		case 2n:
			return "nd";
		case 3n:
			return "rd";
		default:
			return "th";
	}
}
