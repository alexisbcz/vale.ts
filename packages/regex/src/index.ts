/**
 * `@vale-ts/regex` -- the regular-expression layer Vale's rules are written
 * against.
 *
 * Rules come from the Go implementation, where they run under `regexp2` in
 * RE2-compatibility mode: a port of .NET's backtracking engine. This package
 * translates that dialect into a native `RegExp` and wraps it in the API the
 * ported checks expect.
 *
 * ```ts
 * import { Regexp } from "@vale-ts/regex";
 *
 * const re = Regexp.compile(String.raw`(?i)\b(?:very|really)\b`);
 * re.findAllStringIndex("Very really good"); // [[0, 4], [5, 11]]
 * ```
 */

export type {
	Alternation,
	CharClass,
	ClassItem,
	FlagSet,
	Group,
	Node,
	Sequence,
} from "./ast.ts";
export { PatternError, parse } from "./parse.ts";
export { Required, weight } from "./prefilter.ts";
export type { RegexpMatch } from "./regexp.ts";
export { Regexp } from "./regexp.ts";
export type { TranslateOptions, Translation } from "./translate.ts";
export { translate } from "./translate.ts";
export {
	NON_WORD_BOUNDARY,
	RE2_SPACE,
	WORD_BOUNDARY,
	WORD_CHARS,
} from "./unicode.ts";

import { Regexp } from "./regexp.ts";

/** Compiles a pattern; shorthand for `Regexp.compile`. */
export function compile(pattern: string): Regexp {
	return Regexp.compile(pattern);
}

/** Compiles a pattern fixed at build time; shorthand for `Regexp.mustCompile`. */
export function mustCompile(pattern: string): Regexp {
	return Regexp.mustCompile(pattern);
}

/**
 * Escapes every character that has a special meaning, so the result matches
 * the text as written. The equivalent of Go's `regexp.QuoteMeta`.
 */
export function quoteMeta(s: string): string {
	let out = "";
	for (const ch of s) {
		if ("\\.+*?()|[]{}^$".includes(ch)) out += "\\";
		out += ch;
	}
	return out;
}
