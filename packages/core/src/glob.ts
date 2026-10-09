/**
 * The glob patterns a `.vale.ini` section header is written in, and that
 * `--glob` filters files with.
 *
 * Vale compiles a pattern one of two ways, and the difference is visible to
 * users: a pattern holding `**` goes through `doublestar`, where `*` stops at
 * a path separator, and any other pattern goes through `gobwas/glob` with no
 * separators configured, where `*` matches a `/` like anything else. That is
 * why `[*.md]` applies to `docs/guide.md` while a doublestar section header
 * needs the directory to line up.
 */

import { toSlash } from "./util.ts";

export class Glob {
	readonly pattern: string;
	readonly negated: boolean;
	private readonly re: RegExp;

	private constructor(pattern: string, negated: boolean, re: RegExp) {
		this.pattern = pattern;
		this.negated = negated;
		this.re = re;
	}

	/**
	 * Compiles a pattern.
	 *
	 * A leading `!` negates the result, which is how `--glob` excludes files.
	 */
	static compile(pat: string): Glob {
		let pattern = pat;
		let negated = false;
		if (pattern.startsWith("!")) {
			pattern = pattern.replace(/^!+/, "");
			negated = true;
		}

		const crossesSeparators = !pattern.includes("**");
		const source = compilePattern(pattern, crossesSeparators);
		return new Glob(pattern, negated, new RegExp(`^(?:${source})$`, "s"));
	}

	/** Whether the glob matches `query`. */
	match(query: string): boolean {
		return this.re.test(toSlash(query)) !== this.negated;
	}

	/** Whether the glob matches any of `queries`. */
	matchAny(queries: readonly string[]): boolean {
		for (const q of queries) {
			if (this.match(q)) return true;
		}
		return false;
	}
}

/**
 * Turns a glob into a regular-expression body.
 *
 * `crossesSeparators` says which dialect to use: true for the `gobwas/glob`
 * reading, where `*` and `?` are unconstrained, and false for `doublestar`'s,
 * where they stop at a `/` and only a whole `**` segment crosses one.
 */
function compilePattern(pattern: string, crossesSeparators: boolean): string {
	const anyRun = crossesSeparators ? "[\\s\\S]*" : "[^/]*";
	const anyOne = crossesSeparators ? "[\\s\\S]" : "[^/]";

	let out = "";
	let i = 0;
	// Brace depth, so a `,` knows whether it separates alternatives.
	let braces = 0;

	while (i < pattern.length) {
		const c = pattern[i]!;

		switch (c) {
			case "\\": {
				const next = pattern[i + 1];
				if (next === undefined) {
					out += "\\\\";
					i++;
					break;
				}
				out += escapeChar(next);
				i += 2;
				break;
			}

			case "*": {
				if (pattern[i + 1] === "*") {
					let stars = 0;
					while (pattern[i + stars] === "*") stars++;
					if (crossesSeparators) {
						out += "[\\s\\S]*";
						i += stars;
						break;
					}
					// `doublestar`: a `**` that is a whole path component matches
					// any number of components, including none.
					const beforeOk = i === 0 || pattern[i - 1] === "/";
					const after = pattern[i + stars];
					const afterOk = after === undefined || after === "/";
					if (beforeOk && afterOk) {
						if (after === "/") {
							// `a/**/b` has to match `a/b` too, so the separator
							// that follows is consumed here.
							out += "(?:[\\s\\S]*/)?";
							i += stars + 1;
						} else {
							out += "[\\s\\S]*";
							i += stars;
						}
						break;
					}
					// Anywhere else it is read as a single `*`.
					out += anyRun;
					i += stars;
					break;
				}
				out += anyRun;
				i++;
				break;
			}

			case "?":
				out += anyOne;
				i++;
				break;

			case "[": {
				// A class that never closes, or whose ranges are malformed, is
				// reported rather than read as a literal `[`. `Glob.match`
				// cannot report it, which is how `--glob='[a-]*'` used to
				// compile with `MustCompile` and panic partway through a walk.
				const cls = readClass(pattern, i);
				out += cls.source;
				i = cls.next;
				break;
			}

			case "{":
				out += "(?:";
				braces++;
				i++;
				break;

			case "}":
				if (braces > 0) {
					out += ")";
					braces--;
				} else {
					out += "\\}";
				}
				i++;
				break;

			case ",":
				out += braces > 0 ? "|" : ",";
				i++;
				break;

			default:
				out += escapeChar(c);
				i++;
				break;
		}
	}

	// An unbalanced `{` would leave the expression open.
	while (braces > 0) {
		out += ")";
		braces--;
	}

	return out;
}

/**
 * Reads a `[...]` class starting at `i`.
 *
 * Throws for a class the glob libraries reject, which is the only place a
 * pattern can be found invalid. Two shapes matter, because `gobwas/glob`
 * refuses both while `doublestar` accepts them:
 *
 *  - a range with nothing after its `-`, as in `[a-]`, where the `]` is read
 *    as the range's upper bound and the class then never closes;
 *  - a `-` where the class expected to close, as in `[a-b-c]`.
 *
 * A class that never closes at all is refused too, since `doublestar` reports
 * that one as a bad pattern.
 */
function readClass(pattern: string, i: number): { source: string; next: number } {
	let j = i + 1;
	let negated = false;
	if (pattern[j] === "!" || pattern[j] === "^") {
		negated = true;
		j++;
	}
	// A `]` in the first position is a literal.
	let body = "";
	if (pattern[j] === "]") {
		body += "\\]";
		j++;
	}

	// Where the first item of the class sits, so that `[a-]` -- whose `-`
	// cannot be anything but a range separator -- is told apart from `[abc-]`,
	// whose trailing `-` is a literal.
	const start = j;

	// Whether the item just read was a range, so a `-` that follows is the
	// `[a-b-c]` case rather than a literal dash.
	let afterRange = false;

	for (; j < pattern.length; j++) {
		const c = pattern[j]!;
		if (c === "]") {
			// A class cannot be empty, and `[]` is not one.
			if (body === "") {
				// `gobwas/glob` reads the `]` as text and then runs out of input.
				throw new Error("unexpected end of input");
			}
			return {
				source: `[${negated ? "^" : ""}${body}]`,
				next: j + 1,
			};
		}
		if (c === "\\") {
			const next = pattern[j + 1];
			if (next === undefined) break;
			body += escapeInClass(next);
			j++;
			afterRange = false;
			continue;
		}
		if (c === "[" && pattern[j + 1] === ":") {
			const close = pattern.indexOf(":]", j + 2);
			if (close > 0) {
				const name = pattern.slice(j + 2, close);
				const ranges = POSIX[name];
				if (ranges !== undefined) {
					body += ranges;
					j = close + 1;
					afterRange = false;
					continue;
				}
			}
		}
		if (c === "-" && body !== "") {
			if (afterRange) {
				// `gobwas/glob` consumes a range's upper bound and then requires
				// the class to close, so anything else here is this error.
				throw new Error("expected close range character");
			}
			const hi = pattern[j + 1];
			if (hi === "]" && j === start + 1) {
				// `[a-]` reads the `]` as the range's upper bound, so the class
				// never closes and whatever follows is not the `]` it wants.
				throw new Error("expected close range character");
			}
			if (hi !== undefined && hi !== "]") {
				body += "-";
				continue;
			}
			// A `-` with nothing after it to bound a range is a literal, which
			// is how `[abc-]` reads.
			body += "\\-";
			afterRange = false;
			continue;
		}
		body += escapeInClass(c);
		// A `-` only reads as a range separator between two characters, so the
		// item that just closed one is the one whose `-` preceded it.
		afterRange = pattern[j - 1] === "-" && j - 1 > start;
	}

	throw new Error("unexpected end of input");
}

const POSIX: Record<string, string> = {
	alnum: "0-9A-Za-z",
	alpha: "A-Za-z",
	digit: "0-9",
	lower: "a-z",
	space: "\\t\\n\\v\\f\\r ",
	upper: "A-Z",
	punct: "!-/:-@\\[-`\\{-~",
	xdigit: "0-9A-Fa-f",
};

function escapeChar(c: string): string {
	return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
}

function escapeInClass(c: string): string {
	return /[\]\\^-]/.test(c) ? `\\${c}` : c;
}

/** Compiles a pattern; shorthand for `Glob.compile`. */
export function compileGlob(pat: string): Glob {
	return Glob.compile(pat);
}
