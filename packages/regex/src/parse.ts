/**
 * A parser for the regular-expression dialect Vale's rules are written in:
 * .NET's, as `regexp2` implements it, with RE2 compatibility turned on.
 *
 * The parser is deliberately permissive about the things that dialect allows
 * and JavaScript's `u`-mode does not -- an unescaped `]` or `}`, a `{,2}` that
 * isn't a quantifier -- because a rule that works under Vale has to keep
 * working here. Those become literals, exactly as the Go engine reads them.
 */

import type {
	Alternation,
	CharClass,
	ClassItem,
	FlagSet,
	Group,
	Node,
	Sequence,
} from "./ast.ts";
import { seq } from "./ast.ts";

export class PatternError extends Error {
	readonly pattern: string;
	readonly offset: number;
	/** The reason alone, without the pattern quoted after it. */
	readonly reason: string;

	/**
	 * The message reads as `regexp2`'s does: the reason, then the pattern it is
	 * about, quoted.
	 *
	 * That shape is part of the output -- a style author sees it as the `E201`
	 * for their rule, and Vale's own end-to-end cases assert on the text -- so
	 * the wording below matches `regexp2`'s error codes rather than being
	 * phrased afresh. The offset is kept as a field, since nothing in Go's
	 * message carries one.
	 */
	constructor(message: string, pattern: string, offset: number) {
		super(`${message} in \`${pattern}\``);
		this.name = "PatternError";
		this.pattern = pattern;
		this.offset = offset;
		this.reason = message;
	}
}

export interface ParseResult {
	root: Node;
	/** Group names in capture order; index 0 is the whole match and is "". */
	groupNames: string[];
	/** How many capturing groups the pattern has, named ones included. */
	captureCount: number;
	/** Whether the pattern uses a construct that needs the `v` flag. */
	needsSetOps: boolean;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

/**
 * Parses a pattern.
 *
 * `.NET` assigns capture numbers in two passes -- every unnamed group first,
 * then every named one -- which is what `groupSpans` in the `existence` check
 * relies on. The numbering here follows that, so a rule that reads group 3
 * reads the same text it did under Go.
 */
export function parse(pattern: string): ParseResult {
	const p = new Parser(pattern);
	return p.parse();
}

class Parser {
	private readonly src: string;
	private pos = 0;
	/** Flags in force at the current position, for free-spacing mode. */
	private flagStack: FlagSet[] = [{}];
	private unnamed: Group[] = [];
	private named: Group[] = [];
	needsSetOps = false;

	constructor(src: string) {
		this.src = src;
	}

	parse(): ParseResult {
		const root = this.parseAlternation(false);
		if (this.pos < this.src.length) {
			// The only way out of parseAlternation short of the end is a `)`.
			throw new PatternError("unexpected )", this.src, this.pos);
		}

		// .NET numbers unnamed groups first, then named ones.
		const names: string[] = [""];
		let n = 0;
		for (const g of this.unnamed) {
			g.number = ++n;
			names.push("");
		}
		for (const g of this.named) {
			g.number = ++n;
			names.push(g.name ?? "");
		}

		return {
			root,
			groupNames: names,
			captureCount: n,
			needsSetOps: this.needsSetOps,
		};
	}

	private get flags(): FlagSet {
		return this.flagStack[this.flagStack.length - 1]!;
	}

	private peek(ahead = 0): string {
		return this.src[this.pos + ahead] ?? "";
	}

	private eof(): boolean {
		return this.pos >= this.src.length;
	}

	private parseAlternation(nested: boolean): Node {
		const branches: Sequence[] = [];
		for (;;) {
			branches.push(this.parseSequence(nested));
			if (this.peek() === "|") {
				this.pos++;
				continue;
			}
			break;
		}
		if (branches.length === 1) {
			const only = branches[0]!;
			return only.terms.length === 1 ? only.terms[0]! : only;
		}
		const alt: Alternation = { kind: "alt", branches };
		return alt;
	}

	private parseSequence(nested: boolean): Sequence {
		const terms: Node[] = [];
		for (;;) {
			if (this.eof()) break;
			const c = this.peek();
			if (c === "|") break;
			if (c === ")") {
				if (nested) break;
				// A stray `)` is an error in .NET too.
				throw new PatternError("unexpected )", this.src, this.pos);
			}

			const atom = this.parseAtom(nested);
			if (atom === null) continue; // a comment group, or free-spacing noise
			terms.push(this.applyQuantifier(atom, terms));
		}
		return { kind: "seq", terms };
	}

	/**
	 * Attaches a quantifier to `atom`, splitting a literal run first.
	 *
	 * `ab*` repeats only the `b`, so a multi-character literal has its last
	 * character peeled off into its own atom before the quantifier applies.
	 */
	private applyQuantifier(atom: Node, before: Node[]): Node {
		const q = this.tryQuantifier();
		if (!q) return atom;

		let target = atom;
		if (atom.kind === "lit" && [...atom.value].length > 1) {
			const chars = [...atom.value];
			const last = chars.pop()!;
			before.push({ kind: "lit", value: chars.join("") });
			target = { kind: "lit", value: last };
		}

		return {
			kind: "quant",
			atom: target,
			min: q.min,
			max: q.max,
			lazy: q.lazy,
			possessive: q.possessive,
		};
	}

	private tryQuantifier(): {
		min: number;
		max: number;
		lazy: boolean;
		possessive: boolean;
	} | null {
		this.skipFreeSpace();
		const c = this.peek();
		let min: number;
		let max: number;

		if (c === "*") {
			min = 0;
			max = Infinity;
			this.pos++;
		} else if (c === "+") {
			min = 1;
			max = Infinity;
			this.pos++;
		} else if (c === "?") {
			min = 0;
			max = 1;
			this.pos++;
		} else if (c === "{") {
			const parsed = this.tryBraceQuantifier();
			if (!parsed) return null;
			min = parsed.min;
			max = parsed.max;
		} else {
			return null;
		}

		let lazy = false;
		let possessive = false;
		if (this.peek() === "?") {
			lazy = true;
			this.pos++;
		} else if (this.peek() === "+") {
			possessive = true;
			this.pos++;
		}
		return { min, max, lazy, possessive };
	}

	/**
	 * Reads `{n}`, `{n,}` or `{n,m}`.
	 *
	 * Anything else -- `{,2}`, `{}`, `{a}` -- is a literal brace to .NET, so
	 * nothing is consumed and the caller keeps it as text.
	 */
	private tryBraceQuantifier(): { min: number; max: number } | null {
		const start = this.pos;
		let i = this.pos + 1;
		let digits = "";
		while (/[0-9]/.test(this.src[i] ?? "")) digits += this.src[i++];
		if (digits === "") {
			this.pos = start;
			return null;
		}
		const min = Number.parseInt(digits, 10);
		let max = min;
		if (this.src[i] === ",") {
			i++;
			let upper = "";
			while (/[0-9]/.test(this.src[i] ?? "")) upper += this.src[i++];
			max = upper === "" ? Infinity : Number.parseInt(upper, 10);
		}
		if (this.src[i] !== "}") {
			this.pos = start;
			return null;
		}
		this.pos = i + 1;
		return { min, max };
	}

	/** Skips whitespace and `#` comments when free-spacing mode is on. */
	private skipFreeSpace(): void {
		if (!this.flags.x) return;
		for (;;) {
			const c = this.peek();
			if (WHITESPACE.has(c)) {
				this.pos++;
				continue;
			}
			if (c === "#") {
				while (!this.eof() && this.peek() !== "\n") this.pos++;
				continue;
			}
			return;
		}
	}

	/** Returns the next atom, or null when the input held nothing to match. */
	private parseAtom(nested: boolean): Node | null {
		this.skipFreeSpace();
		if (this.eof()) return null;
		const c = this.peek();

		switch (c) {
			case "(":
				return this.parseGroup(nested);
			case "[":
				return this.parseClass();
			case ".":
				this.pos++;
				return { kind: "dot" };
			case "^":
				this.pos++;
				return { kind: "anchor", type: "bol" };
			case "$":
				this.pos++;
				return { kind: "anchor", type: "eol" };
			case "\\":
				return this.parseEscape();
			case "*":
			case "+":
			case "?":
				throw new PatternError(
					"missing argument to repetition operator",
					this.src,
					this.pos,
				);
			default:
				return this.parseLiteralRun();
		}
	}

	/**
	 * Reads a run of literal characters, stopping before anything structural.
	 *
	 * A run rather than a character at a time so that the printed pattern stays
	 * close to the one that was written, which matters when it is shown in an
	 * error message.
	 */
	private parseLiteralRun(): Node {
		let out = "";
		for (;;) {
			if (this.eof()) break;
			const c = this.peek();
			if ("()[].^$\\|*+?".includes(c)) break;
			if (this.flags.x && (WHITESPACE.has(c) || c === "#")) break;
			if (c === "{") {
				// Stop only if it really is a quantifier; otherwise it is text.
				const save = this.pos;
				const q = this.tryBraceQuantifier();
				this.pos = save;
				if (q) break;
			}
			// A quantifier binds to the last character, so a run has to stop
			// before one -- but only when there is already something to repeat.
			if (out !== "") {
				const next = this.src[this.pos + 1] ?? "";
				if ("*+?".includes(next)) {
					out += c;
					this.pos++;
					break;
				}
				if (next === "{") {
					const save = this.pos;
					this.pos++;
					const q = this.tryBraceQuantifier();
					this.pos = save;
					if (q) {
						out += c;
						this.pos++;
						break;
					}
				}
			}
			out += c;
			this.pos++;
		}
		if (out === "") {
			// Defensive: every caller has already checked for a structural char.
			out = this.src[this.pos++] ?? "";
		}
		return { kind: "lit", value: out };
	}

	private parseGroup(_nested: boolean): Node | null {
		const open = this.pos;
		this.pos++; // `(`

		if (this.peek() !== "?") {
			const g: Group = {
				kind: "group",
				type: "capture",
				body: { kind: "empty" },
			};
			if (this.flags.n) {
				// `(?n)` -- an unnamed group stops capturing.
				const body = this.parseAlternation(true);
				this.expect(")", open);
				return { kind: "group", type: "noncapture", body };
			}
			this.unnamed.push(g);
			g.body = this.parseAlternation(true);
			this.expect(")", open);
			return g;
		}

		this.pos++; // `?`
		const c = this.peek();

		// `(?#...)` -- a comment.
		if (c === "#") {
			while (!this.eof() && this.peek() !== ")") this.pos++;
			this.expect(")", open);
			return null;
		}

		// `(?:...)`
		if (c === ":") {
			this.pos++;
			const body = this.parseAlternation(true);
			this.expect(")", open);
			return { kind: "group", type: "noncapture", body };
		}

		// `(?=...)` `(?!...)`
		if (c === "=" || c === "!") {
			this.pos++;
			const body = this.parseAlternation(true);
			this.expect(")", open);
			return {
				kind: "group",
				type: c === "=" ? "lookahead" : "neg-lookahead",
				body,
			};
		}

		// `(?>...)` -- atomic.
		if (c === ">") {
			this.pos++;
			const body = this.parseAlternation(true);
			this.expect(")", open);
			return { kind: "group", type: "atomic", body };
		}

		// `(?<=...)` `(?<!...)` `(?<name>...)`, and `(?'name'...)`.
		if (c === "<" || c === "'") {
			if (c === "<" && (this.peek(1) === "=" || this.peek(1) === "!")) {
				const negated = this.peek(1) === "!";
				this.pos += 2;
				const body = this.parseAlternation(true);
				this.expect(")", open);
				return {
					kind: "group",
					type: negated ? "neg-lookbehind" : "lookbehind",
					body,
				};
			}
			return this.parseNamedGroup(open, c === "<" ? ">" : "'");
		}

		// `(?P<name>...)` and `(?P=name)`, the RE2 spellings.
		if (c === "P") {
			if (this.peek(1) === "<") {
				this.pos++; // `P`
				return this.parseNamedGroup(open, ">");
			}
			if (this.peek(1) === "=") {
				this.pos += 2;
				let name = "";
				while (!this.eof() && this.peek() !== ")") name += this.src[this.pos++];
				this.expect(")", open);
				return { kind: "backref", ref: name };
			}
		}

		// `(?imsxn-imsxn)` or `(?imsx-imsx:...)`.
		return this.parseFlagGroup(open);
	}

	private parseNamedGroup(open: number, closer: string): Node {
		this.pos++; // `<` or `'`
		let name = "";
		while (!this.eof() && this.peek() !== closer) name += this.src[this.pos++];
		if (this.eof()) {
			throw new PatternError(
				"invalid group name: group names must begin with a word character and have a matching terminator",
				this.src,
				open,
			);
		}
		this.pos++; // closer

		// `(?<name-other>...)`: .NET's balancing groups. Vale has no use for
		// them, and translating one would be a lie, so say so.
		if (name.includes("-")) {
			throw new PatternError(
				`balancing group \`${name}\` is not supported`,
				this.src,
				open,
			);
		}

		// A purely numeric name is .NET's way of renumbering a group.
		const g: Group = {
			kind: "group",
			type: "named",
			name,
			body: { kind: "empty" },
		};
		this.named.push(g);
		g.body = this.parseAlternation(true);
		this.expect(")", open);
		return g;
	}

	private parseFlagGroup(open: number): Node | null {
		const set: FlagSet = {};
		const clear: FlagSet = {};
		let target = set;
		let saw = false;

		for (;;) {
			const c = this.peek();
			if (c === "-") {
				target = clear;
				this.pos++;
				continue;
			}
			if (c === "i" || c === "m" || c === "s" || c === "x" || c === "n") {
				target[c] = true;
				saw = true;
				this.pos++;
				continue;
			}
			break;
		}

		if (!saw) {
			throw new PatternError(
				`unrecognized grouping construct: (?${this.src.slice(this.pos, this.pos + 1)}`,
				this.src,
				open,
			);
		}

		if (this.peek() === ":") {
			this.pos++;
			this.flagStack.push(applyFlags(this.flags, set, clear));
			const body = this.parseAlternation(true);
			this.flagStack.pop();
			this.expect(")", open);
			return { kind: "group", type: "scoped-flags", set, clear, body };
		}

		this.expect(")", open);
		// A bare directive changes the flags for the rest of the enclosing
		// group, which for parsing means from here on.
		this.flagStack[this.flagStack.length - 1] = applyFlags(this.flags, set, clear);
		return { kind: "inline-flags", set, clear };
	}

	private expect(ch: string, open: number): void {
		if (this.peek() !== ch) {
			// Only ever a `)`: a group that never closes.
			throw new PatternError(
				ch === ")" ? "missing closing )" : `missing closing ${ch}`,
				this.src,
				open,
			);
		}
		this.pos++;
	}

	// --- escapes ------------------------------------------------------------

	private parseEscape(): Node {
		const start = this.pos;
		this.pos++; // `\`
		if (this.eof()) {
			throw new PatternError(
				String.raw`illegal \ at end of pattern`,
				this.src,
				start,
			);
		}
		const c = this.src[this.pos++]!;

		switch (c) {
			case "d":
			case "D":
			case "w":
			case "W":
			case "s":
			case "S":
				return {
					kind: "class",
					negated: false,
					items: [{ type: "shorthand", name: c }],
				};
			case "p":
			case "P":
				return this.parseProperty(c === "P", start);
			case "b":
				return { kind: "anchor", type: "word" };
			case "B":
				return { kind: "anchor", type: "nonword" };
			case "A":
				return { kind: "anchor", type: "begin" };
			case "z":
				return { kind: "anchor", type: "end" };
			case "Z":
				return { kind: "anchor", type: "endz" };
			case "G":
				return { kind: "anchor", type: "start" };
			case "k": {
				// `\k<name>` or `\k'name'`.
				const openCh = this.peek();
				if (openCh === "<" || openCh === "'") {
					const closer = openCh === "<" ? ">" : "'";
					this.pos++;
					let name = "";
					while (!this.eof() && this.peek() !== closer) {
						name += this.src[this.pos++];
					}
					this.pos++;
					return { kind: "backref", ref: name };
				}
				return { kind: "lit", value: "k" };
			}
			default:
				break;
		}

		if (c >= "1" && c <= "9") {
			let digits = c;
			while (/[0-9]/.test(this.peek())) digits += this.src[this.pos++];
			return { kind: "backref", ref: Number.parseInt(digits, 10) };
		}

		this.pos = start + 1;
		const code = this.readEscapedChar();
		return { kind: "lit", value: String.fromCodePoint(code) };
	}

	private parseProperty(negated: boolean, start: number): Node {
		if (this.peek() === "{") {
			this.pos++;
			let name = "";
			while (!this.eof() && this.peek() !== "}") name += this.src[this.pos++];
			if (this.eof()) {
				throw new PatternError(
					String.raw`incomplete \p{X} character escape`,
					this.src,
					start,
				);
			}
			this.pos++;
			let neg = negated;
			if (name.startsWith("^")) {
				neg = !neg;
				name = name.slice(1);
			}
			return {
				kind: "class",
				negated: false,
				items: [{ type: "property", name, negated: neg }],
			};
		}
		// RE2/PCRE's one-letter form: `\pL`.
		const letter = this.src[this.pos++] ?? "";
		if (letter === "") {
			throw new PatternError(
				String.raw`malformed \p{X} character escape`,
				this.src,
				start,
			);
		}
		return {
			kind: "class",
			negated: false,
			items: [{ type: "property", name: letter, negated }],
		};
	}

	/**
	 * Reads the character an escape stands for, with `\` already consumed.
	 *
	 * Used both outside and inside a character class, where the set of escapes
	 * is the same apart from `\b`, which means a backspace inside one.
	 */
	private readEscapedChar(): number {
		const c = this.src[this.pos++]!;
		switch (c) {
			case "a":
				return 0x07;
			case "b":
				return 0x08;
			case "e":
				return 0x1b;
			case "f":
				return 0x0c;
			case "n":
				return 0x0a;
			case "r":
				return 0x0d;
			case "t":
				return 0x09;
			case "v":
				return 0x0b;
			case "0": {
				// `\0` plus up to two more octal digits.
				let oct = "";
				while (oct.length < 2 && /[0-7]/.test(this.peek())) {
					oct += this.src[this.pos++];
				}
				return oct === "" ? 0 : Number.parseInt(oct, 8);
			}
			case "x": {
				if (this.peek() === "{") {
					this.pos++;
					let hex = "";
					while (!this.eof() && this.peek() !== "}") hex += this.src[this.pos++];
					this.pos++;
					return Number.parseInt(hex, 16);
				}
				const hex = this.src.slice(this.pos, this.pos + 2);
				this.pos += 2;
				return Number.parseInt(hex, 16);
			}
			case "u": {
				if (this.peek() === "{") {
					this.pos++;
					let hex = "";
					while (!this.eof() && this.peek() !== "}") hex += this.src[this.pos++];
					this.pos++;
					return Number.parseInt(hex, 16);
				}
				const hex = this.src.slice(this.pos, this.pos + 4);
				this.pos += 4;
				return Number.parseInt(hex, 16);
			}
			case "c": {
				const ch = this.src[this.pos++] ?? "";
				return ch.toUpperCase().charCodeAt(0) % 32;
			}
			default:
				return c.codePointAt(0)!;
		}
	}

	// --- character classes --------------------------------------------------

	private parseClass(): CharClass {
		const open = this.pos;
		this.pos++; // `[`

		const cls: CharClass = { kind: "class", negated: false, items: [] };
		if (this.peek() === "^") {
			cls.negated = true;
			this.pos++;
		}
		// A `]` in the first position is a literal, as in .NET and POSIX.
		if (this.peek() === "]") {
			cls.items.push({ type: "char", value: 0x5d });
			this.pos++;
		}

		for (;;) {
			if (this.eof()) {
				throw new PatternError("unterminated [] set", this.src, open);
			}
			if (this.peek() === "]") {
				this.pos++;
				break;
			}

			// .NET's subtraction: `[a-z-[aeiou]]`.
			if (this.peek() === "-" && this.peek(1) === "[") {
				this.pos++;
				cls.subtract = this.parseClass();
				this.needsSetOps = true;
				this.expect("]", open);
				break;
			}

			// `[[:alpha:]]`
			if (this.peek() === "[" && this.peek(1) === ":") {
				const close = this.src.indexOf(":]", this.pos + 2);
				if (close > 0) {
					let name = this.src.slice(this.pos + 2, close);
					let negated = false;
					if (name.startsWith("^")) {
						negated = true;
						name = name.slice(1);
					}
					cls.items.push({ type: "posix", name, negated });
					this.pos = close + 2;
					continue;
				}
			}

			const lo = this.parseClassAtom();
			if (lo === null) continue;

			// A range, unless the `-` is the last character in the class.
			if (
				typeof lo === "number" &&
				this.peek() === "-" &&
				this.peek(1) !== "]" &&
				this.peek(1) !== ""
			) {
				const dash = this.pos;
				this.pos++;
				const hi = this.parseClassAtom();
				if (hi === null || typeof hi !== "number") {
					// `[a-\d]` is an error in .NET; read the `-` as a literal
					// instead, which is what Go's engine does.
					this.pos = dash;
					cls.items.push({ type: "char", value: lo });
					continue;
				}
				if (hi < lo) {
					throw new PatternError(
						`[${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}] range in reverse order`,
						this.src,
						dash,
					);
				}
				cls.items.push({ type: "range", from: lo, to: hi });
				continue;
			}

			if (typeof lo === "number") {
				cls.items.push({ type: "char", value: lo });
			} else {
				cls.items.push(lo);
			}
		}

		return cls;
	}

	/**
	 * Returns the next class member: a code point, a set-valued item, or null
	 * when free-spacing mode skipped over something.
	 */
	private parseClassAtom(): number | ClassItem | null {
		const c = this.peek();
		if (c !== "\\") {
			this.pos++;
			const cp = c.codePointAt(0)!;
			// A surrogate pair is one character.
			if (cp > 0xffff) this.pos++;
			return cp;
		}

		this.pos++; // `\`
		const esc = this.peek();
		switch (esc) {
			case "d":
			case "D":
			case "w":
			case "W":
			case "s":
			case "S":
				this.pos++;
				return { type: "shorthand", name: esc };
			case "p":
			case "P": {
				this.pos++;
				const negated = esc === "P";
				if (this.peek() === "{") {
					this.pos++;
					let name = "";
					while (!this.eof() && this.peek() !== "}") name += this.src[this.pos++];
					this.pos++;
					let neg = negated;
					if (name.startsWith("^")) {
						neg = !neg;
						name = name.slice(1);
					}
					return { type: "property", name, negated: neg };
				}
				const letter = this.src[this.pos++] ?? "";
				return { type: "property", name: letter, negated };
			}
			default:
				return this.readEscapedChar();
		}
	}
}

function applyFlags(base: FlagSet, set: FlagSet, clear: FlagSet): FlagSet {
	const out: FlagSet = { ...base };
	for (const k of ["i", "m", "s", "x", "n"] as const) {
		if (set[k]) out[k] = true;
		if (clear[k]) out[k] = false;
	}
	return out;
}

export { seq };
