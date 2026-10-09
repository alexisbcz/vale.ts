/**
 * The abstract syntax tree the pattern translator works on.
 *
 * Vale's rules are written for `regexp2` in RE2-compatibility mode, which is a
 * port of .NET's engine. That dialect is close to JavaScript's but not the
 * same: it has inline flag directives (`(?i)`), Unicode-aware word boundaries,
 * RE2's narrower `\s`, `(?P<name>...)` group syntax, atomic groups and
 * character-class subtraction. Rewriting the pattern as text with regular
 * expressions would be guesswork, so it is parsed into this tree, rewritten,
 * and printed back out as a pattern `RegExp` accepts.
 */

/** Flags an inline directive can set or clear. */
export interface FlagSet {
	/** `i` -- case-insensitive. */
	i?: boolean;
	/** `m` -- `^`/`$` match at line boundaries. */
	m?: boolean;
	/** `s` -- `.` matches a newline. */
	s?: boolean;
	/** `x` -- free-spacing mode; resolved while parsing, never printed. */
	x?: boolean;
	/** `n` -- explicit capture only; .NET-only, resolved while parsing. */
	n?: boolean;
}

export type Node =
	| Alternation
	| Sequence
	| Literal
	| CharClass
	| Group
	| Anchor
	| Backreference
	| Quantified
	| InlineFlags
	| Dot
	| Empty;

/** `a|b|c` */
export interface Alternation {
	kind: "alt";
	branches: Sequence[];
}

/** A run of terms matched one after another. */
export interface Sequence {
	kind: "seq";
	terms: Node[];
}

/** One or more characters matched literally. */
export interface Literal {
	kind: "lit";
	/** The characters, already unescaped. */
	value: string;
}

/** `.` */
export interface Dot {
	kind: "dot";
}

/** The empty expression, which matches at any position. */
export interface Empty {
	kind: "empty";
}

/**
 * A character class, either bracketed (`[a-z]`) or a shorthand escape that
 * stands for a set (`\d`, `\p{L}`).
 */
export interface CharClass {
	kind: "class";
	negated: boolean;
	items: ClassItem[];
	/** `[a-z-[aeiou]]`: the items this class subtracts, .NET-style. */
	subtract?: CharClass;
}

export type ClassItem =
	/** A single character. */
	| { type: "char"; value: number }
	/** An inclusive range of characters. */
	| { type: "range"; from: number; to: number }
	/** A shorthand escape: `d`, `D`, `w`, `W`, `s`, `S`, `h`, `v`. */
	| { type: "shorthand"; name: string }
	/** `\p{...}` / `\P{...}`. */
	| { type: "property"; name: string; negated: boolean }
	/** A POSIX bracket expression, e.g. `[:alpha:]`. */
	| { type: "posix"; name: string; negated: boolean }
	/** A nested class, which only .NET's subtraction syntax produces. */
	| { type: "nested"; value: CharClass };

export type GroupKind =
	| "capture"
	| "named"
	| "noncapture"
	| "lookahead"
	| "neg-lookahead"
	| "lookbehind"
	| "neg-lookbehind"
	| "atomic"
	| "scoped-flags"
	| "balancing";

/** Any parenthesized construct. */
export interface Group {
	kind: "group";
	type: GroupKind;
	/** The group's name, for `named`. */
	name?: string;
	/** The capture number assigned while parsing, for `capture` and `named`. */
	number?: number;
	/** Flags, for `scoped-flags`. */
	set?: FlagSet;
	clear?: FlagSet;
	body: Node;
}

/** A zero-width assertion written as an escape or as `^`/`$`. */
export interface Anchor {
	kind: "anchor";
	/**
	 * `^` `$` `\A` `\z` `\Z` `\G`, and the word boundaries `\b` / `\B`.
	 */
	type: "bol" | "eol" | "begin" | "end" | "endz" | "start" | "word" | "nonword";
}

/** `\1`, `\k<name>`, `(?P=name)`. */
export interface Backreference {
	kind: "backref";
	/** Either a group number or a group name. */
	ref: number | string;
}

/** An atom with a repetition attached. */
export interface Quantified {
	kind: "quant";
	atom: Node;
	min: number;
	/** `Infinity` for an open upper bound. */
	max: number;
	/** `?` -- prefer the shorter match. */
	lazy: boolean;
	/** `+` -- .NET's possessive quantifier. */
	possessive: boolean;
}

/**
 * A bare `(?i)` directive, which has no body: it changes the flags for the
 * rest of the group it appears in. The renderer turns it into a scoped group.
 */
export interface InlineFlags {
	kind: "inline-flags";
	set: FlagSet;
	clear: FlagSet;
}

export const EMPTY: Empty = { kind: "empty" };

export function seq(terms: Node[]): Node {
	if (terms.length === 0) return EMPTY;
	if (terms.length === 1) return terms[0]!;
	return { kind: "seq", terms };
}
