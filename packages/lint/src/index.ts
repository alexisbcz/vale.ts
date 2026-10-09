/**
 * `@vale-ts/lint` -- the readers that turn a document into the blocks Vale's
 * rules run against.
 *
 * Every markup format is converted to HTML and read by one walker, so the
 * format-specific part of each reader is small: prepare the source, convert it,
 * and hand the result over. The walker is where the work is, and
 * `walker.ts`/`ast.ts` is where to look first.
 *
 * ```ts
 * import { createLinter } from "@vale-ts/lint";
 *
 * const linter = createLinter(manager);
 * const files = linter.lint(["docs"], "*");
 * ```
 */

import type { Manager } from "@vale-ts/check";
import type { File } from "@vale-ts/core";
import { lintHTML } from "./html.ts";
import { Linter } from "./lint.ts";
import { lintMarkdown } from "./md.ts";

export type { ReaderHost } from "./ast.ts";
export {
	clean,
	INLINE_TAGS,
	INLINE_TO_SCOPE,
	inlineRuns,
	leadingSpace,
	lintHTMLTokens,
	lintScope,
	MARK_ATTR,
	metaScope,
	SKIP_CLASSES,
	SKIP_TAGS,
	shouldBeSkipped,
	summarize,
	TAG_TO_SCOPE,
	trailingSpace,
	VOID_TAGS,
	withClasses,
} from "./ast.ts";
export type { HTMLHost } from "./html.ts";
export { lintHTML, textToHTML } from "./html.ts";
export type { LintResult } from "./lint.ts";
export { DocumentErrors, Linter } from "./lint.ts";
export { mathCloserIndex, mathPlugin } from "./math.ts";
export type { MarkdownHost } from "./md.ts";
export { lintMarkdown, lintMarkdownWith, newMarkdown, prepMarkdown } from "./md.ts";
export type { MetadataHost } from "./metadata.ts";
export { lintMetadata } from "./metadata.ts";
export type { ExtensionConfig } from "./patterns.ts";
export {
	applyPatterns,
	BLOCK_DELIMITERS,
	hasPatterns,
	INLINE_DELIMITERS,
	sectionMatches,
} from "./patterns.ts";
export type { ScopedHost } from "./scoped.ts";
export { isCode, lintScopedValues } from "./scoped.ts";
export { markSelections, wrapQuotes, wrapSections } from "./selection.ts";
export type { Attribute, Token } from "./tokenizer.ts";
export { getAttribute, Tokenizer, TokenType, unescape } from "./tokenizer.ts";
export {
	adjustPos,
	distance,
	findBestLineBySubstring,
	findLine,
	findLineBySubstring,
	leadingSpaces,
	similarity,
} from "./util.ts";
export type { Aggregate, InlineCapture } from "./walker.ts";
export { isMask, scopeSafe, trimASCII, Walker } from "./walker.ts";

/**
 * A linter with every reader this build knows registered.
 *
 * The readers are plugged in here rather than named inside the `Linter` so that
 * a caller can leave one out, or add one of their own, without touching the
 * engine.
 */
export function createLinter(manager: Manager): Linter {
	const linter = new Linter(manager);

	linter.register(".md", (f: File) => lintMarkdown(linter, f));
	linter.register(".html", (f: File) => lintHTML(linter, f));

	for (const extend of READER_EXTENSIONS) extend(linter);

	return linter;
}

/**
 * The readers registered on top of the built-in ones.
 *
 * A reader for a format that needs an external converter -- AsciiDoc needs
 * Asciidoctor, reStructuredText needs Docutils -- registers itself here, so
 * that nothing about those formats is loaded by a caller that never lints one.
 */
const READER_EXTENSIONS: Array<(linter: Linter) => void> = [];

/** Registers a reader to be added to every linter `createLinter` builds. */
export function addReader(extend: (linter: Linter) => void): void {
	READER_EXTENSIONS.push(extend);
}
