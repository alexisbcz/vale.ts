/**
 * The documentation conventions on top of a language's comment syntax.
 *
 * A documentation comment has rules of its own: a tag that names a parameter,
 * a bracket that links to another symbol, a block that holds example code.
 * None of it is prose. Each convention here returns the ranges of a comment's
 * text that it marks as code, and an alert inside one is dropped.
 *
 * Masking rather than editing the text keeps the markup as written: a space
 * put where a tag was reads as an indented code block in Markdown, and takes
 * the description after it out of the document.
 */

import type { Node } from "web-tree-sitter";

/** A range of a comment's text that holds no prose. */
export type Mask = [number, number];

/** The range of each match of `re` in `s`. */
function ranges(re: RegExp, s: string): Mask[] {
	const out: Mask[] = [];
	for (const m of s.matchAll(re)) out.push([m.index, m.index + m[0].length]);
	return out;
}

/**
 * The range of the first group of each match: the bracket itself, and not the
 * character after it that settled whether the bracket was a link at all.
 */
function groupRanges(re: RegExp, s: string): Mask[] {
	const out: Mask[] = [];
	for (const m of s.matchAll(re)) {
		const g = m[1];
		if (g === undefined) continue;
		// The group is the first thing the pattern matches, so it begins where
		// the match does.
		out.push([m.index, m.index + g.length]);
	}
	return out;
}

/**
 * A bracketed symbol is a link when nothing turns it into ordinary Markdown: a
 * `(` or `[` after it makes a link with its own target, and a `:` a link
 * definition.
 */
const LINK_END = "([^(\\[:]|$)";

const GO_LINK = new RegExp(`(\\[\\*?[A-Za-z_][\\w.]*\\])${LINK_END}`, "g");
const RUST_LINK = new RegExp(
	`(\\[\`[^\`\\n]+\`\\]|\\[[A-Za-z_][\\w:]*\\])${LINK_END}`,
	"g",
);
const KDOC_LINK = new RegExp(`(\\[[A-Za-z_][\\w.]*\\])${LINK_END}`, "g");
const KDOC_REF = /\[[^\]\n]+\](\[[A-Za-z_][\w.]*\])/g;

const KDOC_NAMED_TAG =
	/^[ \t]*@(?:param|property|throws|exception|see|sample|suppress)[ \t]+\S+/gm;
const KDOC_BARE_TAG = /^[ \t]*@(?:return|constructor|receiver|author|since)\b/gm;

const JAVADOC_INLINE =
	/\{@(?:code|link|linkplain|literal|value|docRoot|inheritDoc|index|summary|systemProperty|snippet|return)\b[^}]*\}/g;
const JAVADOC_NAMED_TAG =
	/^[ \t]*@(?:param|throws|exception|see|since|author|version|serial|serialField|serialData|provides|uses|hidden)[ \t]+\S+/gm;
const JAVADOC_BARE_TAG =
	/^[ \t]*@(?:return|deprecated|apiNote|implNote|implSpec)\b/gm;

const JSDOC_INLINE = /\{@(?:link|linkcode|linkplain|tutorial)\b[^}]*\}/g;
const JSDOC_NAMED_TAG =
	/^[ \t]*@(?:param|arg|argument|prop|property|typedef|callback|event|member|var|name|alias|memberof|augments|extends|mixes|borrows|function|func|method|class|constructor|namespace|module|enum|external|host|kind|listens|fires|emits|this|requires|template|implements|satisfies|see)\b(?:[ \t]*\{[^}\n]*\})?(?:[ \t]+\[?[\w.$#~/-]+(?:=[^\]\n]*)?\]?)?/gm;
const JSDOC_TYPED_TAG =
	/^[ \t]*@(?:returns?|throws|exception|type|yields?|default|defaultvalue)\b(?:[ \t]*\{[^}\n]*\})?/gm;
const JSDOC_BARE_TAG = /^[ \t]*@[A-Za-z]+\b/gm;
const JSDOC_TAG_LINE = /^[ \t]*@[A-Za-z]+\b/;
const JSDOC_EXAMPLE = /^[ \t]*@example\b/;

const PYDOC_NAMED_FIELD =
	/^[ \t]*:(?:param|parameter|arg|argument|key|keyword|type|raises|raise|except|exception|var|ivar|cvar|vartype|meta)[ \t]+[^:\n]+:/gm;
const PYDOC_BARE_FIELD = /^[ \t]*:(?:returns?|rtype|yields?|ytype)[ \t]*:/gm;

/** Masks a Go doc comment's links: `[Name]` and `[pkg.Name]`. */
export function goDoc(s: string): Mask[] {
	return groupRanges(GO_LINK, s);
}

/** Masks a rustdoc comment's intra-doc links. */
export function rustDoc(s: string): Mask[] {
	return groupRanges(RUST_LINK, s);
}

/** Masks a KDoc comment's links and the symbols its block tags name. */
export function kDoc(s: string): Mask[] {
	return [
		...kdocRefRanges(s),
		...groupRanges(KDOC_LINK, s),
		...ranges(KDOC_NAMED_TAG, s),
		...ranges(KDOC_BARE_TAG, s),
	];
}

/**
 * The reference half of `[text][ref]`.
 *
 * The group is not the first thing the pattern matches here, so its range is
 * measured from the end of the match rather than the start.
 */
function kdocRefRanges(s: string): Mask[] {
	const out: Mask[] = [];
	for (const m of s.matchAll(KDOC_REF)) {
		const g = m[1];
		if (g === undefined) continue;
		const end = m.index + m[0].length;
		out.push([end - g.length, end]);
	}
	return out;
}

/** Masks a Javadoc comment's inline tags and the symbols its block tags name. */
export function javadoc(s: string): Mask[] {
	return [
		...ranges(JAVADOC_INLINE, s),
		...ranges(JAVADOC_NAMED_TAG, s),
		...ranges(JAVADOC_BARE_TAG, s),
	];
}

/**
 * Masks a JSDoc comment's inline tags, its block tags with their types and
 * names, and the whole of an `@example` block.
 */
export function jsDoc(s: string): Mask[] {
	return [
		...exampleRanges(s),
		...ranges(JSDOC_INLINE, s),
		...ranges(JSDOC_NAMED_TAG, s),
		...ranges(JSDOC_TYPED_TAG, s),
		...ranges(JSDOC_BARE_TAG, s),
	];
}

/**
 * Masks each `@example` block: the tag's line and every line after it up to
 * the next tag.
 */
function exampleRanges(s: string): Mask[] {
	const out: Mask[] = [];
	let at = 0;
	let inExample = false;

	for (const line of splitAfter(s, "\n")) {
		if (JSDOC_EXAMPLE.test(line)) inExample = true;
		else if (JSDOC_TAG_LINE.test(line)) inExample = false;
		if (inExample) out.push([at, at + line.length]);
		at += line.length;
	}

	return out;
}

/** Splits `s` after each `sep`, as Go's `strings.SplitAfter` does. */
function splitAfter(s: string, sep: string): string[] {
	const parts = s.split(sep);
	const out = parts.map((p) => p + sep);
	out[out.length - 1] = parts[parts.length - 1];
	return out;
}

/**
 * Masks the field names of a docstring's reStructuredText field list:
 * `:param name:` and `:raises Type:` up to the description.
 */
export function pyDoc(s: string): Mask[] {
	return [...ranges(PYDOC_NAMED_FIELD, s), ...ranges(PYDOC_BARE_FIELD, s)];
}

/**
 * Masks `name` at the start of `text`, where a Go doc comment puts the name of
 * what it documents, and reports whether it was there.
 */
export function leadingMask(text: string, name: string): Mask | null {
	if (name === "" || !text.startsWith(name)) return null;
	const rest = text.slice(name.length);
	if (rest !== "") {
		const r = rest[0];
		if (/[\p{L}\p{N}_]/u.test(r)) return null;
	}
	return [0, name.length];
}

/**
 * The name a Go doc comment is expected to open with: that of the declaration
 * it precedes, or `Package name` for a package clause.
 */
export function goDocName(n: Node): string {
	const next = n.nextNamedSibling;
	if (next === null) return "";

	switch (next.type) {
		case "package_clause": {
			const id = next.namedChild(0);
			return id === null ? "" : `Package ${id.text}`;
		}
		case "function_declaration":
		case "method_declaration":
		case "type_spec":
		case "var_spec":
		case "const_spec":
		case "field_declaration":
		case "method_spec":
		case "method_elem": {
			const name = next.childForFieldName("name");
			return name === null ? "" : name.text;
		}
		case "type_declaration":
		case "var_declaration":
		case "const_declaration": {
			for (let i = 0; i < next.namedChildCount; i++) {
				const name = next.namedChild(i)?.childForFieldName("name");
				if (name !== null && name !== undefined) return name.text;
			}
			return "";
		}
		default:
			return "";
	}
}

/**
 * Comments addressed to a tool rather than a reader: a build constraint, a
 * linter suppression, a formatter switch. They hold no prose and are dropped
 * before anything is read.
 */
export const GO_DIRECTIVE =
	/^\/\/(?:go:|line |export |extern |nolint\b|lint:ignore|[a-z0-9]+:[a-z0-9])/;
export const PY_DIRECTIVE =
	/^#[ \t]*(?:noqa\b|type:|pylint:|pragma\b|fmt:[ \t]*(?:on|off|skip)|isort:|mypy:|pyright:|ruff:|flake8:|nosec\b|pyre-|coverage:|-\*-)/;
export const JS_DIRECTIVE =
	/^\/\/[ \t]*(?:eslint|@ts-|prettier-ignore|biome-ignore|istanbul\b|c8\b|v8\b|@flow\b|@jsx|jshint|jslint)|^\/\*[ \t]*(?:eslint|globals?\b|jshint|jslint|istanbul\b|c8\b|@flow\b|@jsx|webpackChunkName|[@#]__PURE__)/;
export const JAVA_DIRECTIVE =
	/^\/\/[ \t]*(?:NOPMD|NOSONAR|CHECKSTYLE|noinspection|@formatter:|\$NON-NLS)/;
export const KOTLIN_DIRECTIVE =
	/^\/\/[ \t]*(?:ktlint|NOSONAR|noinspection|@formatter:)/;
export const C_DIRECTIVE =
	/^\/\/[ \t]*(?:NOLINT|clang-format|cppcheck-suppress)|^\/\*[ \t]*(?:NOLINT|clang-format)/;
export const CSHARP_DIRECTIVE =
	/^\/\/[ \t]*(?:ReSharper (?:disable|restore)\b|NOSONAR)/;
export const RUBY_DIRECTIVE =
	/^#[ \t]*(?:rubocop:|frozen_string_literal:|encoding:|typed:|sorbet:|-\*-)/;
