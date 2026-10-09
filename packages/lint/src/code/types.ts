/**
 * What a comment is, and what a language says about its comments.
 *
 * These live apart from the modules that build and consume them so that the
 * language table, the query engine and the hand-written scanner can all refer
 * to the same shapes without importing each other.
 */

import type { Scope } from "@vale-ts/core";
import type { Language as Grammar, Node } from "web-tree-sitter";
import type { Mask } from "./doc.ts";

/** An in-code comment, line or block. */
export interface Comment {
	/** The comment's prose: its delimiters and decoration removed. */
	text: string;
	/** The comment as written, delimiters included. */
	source: string;
	/** The 1-based line the comment begins on. */
	line: number;
	/** The column the comment begins at, 0-based. */
	offset: number;
	scope: string;
	/**
	 * For each line of `text`, how much was taken off the front of the matching
	 * `source` line. An alert's column is meaningful in `text`; putting it back
	 * in `source` means adding this.
	 *
	 * Empty for a comment that was never dedented, in which case the caller
	 * falls back to measuring the source line itself.
	 */
	strip: number[];
	/** The markup the comment is written in, from the query's `type`; "" for plain lines. */
	format: string;
	/**
	 * The name the comment is expected to open with, when it documents a
	 * declaration. See `Language.docName`.
	 */
	doc: string;
	/** The ranges of `text` that hold no prose; an alert inside one is dropped. */
	masks: Mask[];
}

/** The comment delimiters of a language with no tree-sitter grammar. */
export interface ScannerDelims {
	/** A line comment, from its marker to the end of the line. */
	inline: RegExp;
	/** The line that opens a block comment. */
	blockStart: RegExp;
	/** The line that closes one. */
	blockEnd: RegExp;
}

/** A programming language Vale can read the comments of. */
export interface Language {
	/**
	 * The comment delimiters, as one alternation.
	 *
	 * Written longest alternative first: Go matches this in leftmost-longest
	 * mode and JavaScript matches leftmost-first, so `#=` has to come before
	 * `#` for the opener to come off whole.
	 */
	delims: RegExp;
	/**
	 * A block comment's per-line decoration -- the ` *` that starts each line
	 * of a JSDoc or Javadoc block.
	 *
	 * This is not the same thing as `cutset`. Decoration is noise of a known
	 * width that has to come off for the body to be valid markup; indentation
	 * is meaningful and only its common part comes off. Conflating them is why
	 * a cutset of " *" cannot work: `*` is both the decoration and Markdown's
	 * list and emphasis marker, so a cutset wide enough to remove the noise
	 * also eats a list.
	 *
	 * The match is blanked rather than deleted, which keeps every column where
	 * it was and leaves the dedent to remove the whitespace it becomes.
	 */
	prefix: RegExp | null;
	/** The queries that select the comments, each with the markup it holds. */
	queries: Scope[];
	/** The characters a block comment is dedented by; " \t" when empty. */
	cutset: string;
	/** How much of a source line is marker rather than prose. */
	padding: (s: string) => number;
	/**
	 * A comment addressed to a tool -- a build constraint, a linter
	 * suppression -- which is dropped rather than read. Matched against the
	 * comment as written, delimiter included.
	 */
	directive: RegExp | null;
	/**
	 * Masks what the language's documentation convention marks as code: the
	 * tags of Javadoc, the links of rustdoc. See `doc.ts`.
	 */
	doc: ((text: string) => Mask[]) | null;
	/**
	 * The name a documentation comment is expected to open with, read from the
	 * node it precedes; null for a language with no such convention.
	 */
	docName: ((n: Node, src: string) => string) | null;
	/** The tree-sitter grammar, or null for a language read by the scanner. */
	grammar: Grammar | null;
	/** The comment delimiters, for a language with no grammar. */
	scanner: ScannerDelims | null;
}

/** What came off the front of a line, 1-based as alerts are. */
export function stripAt(c: Comment, line: number): number | null {
	if (line < 1 || line > c.strip.length) return null;
	return c.strip[line - 1];
}

/**
 * Whether the position -- a 1-based line of the comment's text and a 1-based
 * column in code points, as an alert carries them -- falls in one of the
 * comment's masks.
 */
export function masked(c: Comment, line: number, col: number): boolean {
	if (c.masks.length === 0) return false;

	// The offset of the position within the comment's text.
	let at = 0;
	let ln = 1;
	while (ln < line) {
		const nl = c.text.indexOf("\n", at);
		if (nl < 0) return false;
		at = nl + 1;
		ln++;
	}
	for (let i = 1; i < col && at < c.text.length; i++) {
		const cp = c.text.codePointAt(at);
		at += cp !== undefined && cp > 0xffff ? 2 : 1;
	}

	for (const [from, to] of c.masks) {
		if (at >= from && at < to) return true;
	}
	return false;
}
