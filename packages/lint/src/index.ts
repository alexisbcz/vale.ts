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
 * import { createLinterAsync } from "@vale-ts/lint";
 *
 * const linter = await createLinterAsync(manager);
 * const files = linter.lint(["docs"], "*");
 * ```
 *
 * # One asynchronous step
 *
 * Reading a source file's comments needs tree-sitter, whose WebAssembly
 * cannot be compiled synchronously. So the grammars are loaded once, up
 * front, by `initCode`, and every reader stays synchronous. `createLinterAsync`
 * does that for you; `createLinter` does not, and a linter built with it
 * throws a clear error -- naming `initCode` -- if it reaches a source file
 * before the grammars are there.
 */

import type { Manager } from "@vale-ts/check";
import type { File } from "@vale-ts/core";
import { lintADoc } from "./adoc.ts";
import { initCode } from "./code/index.ts";
import { lintCode } from "./code.ts";
import { hasCodeView, hasView, isRuleFile, lintData, lintRule } from "./data.ts";
import { lintDITA } from "./dita.ts";
import { lintFragments } from "./fragment.ts";
import { lintHTML } from "./html.ts";
import { Linter } from "./lint.ts";
import { lintMarkdown } from "./md.ts";
import { lintMDX } from "./mdx.ts";
import { lintMyST } from "./myst.ts";
import { lintNotebook } from "./notebook.ts";
import { lintOrg } from "./org.ts";
import { lintQDoc } from "./qdoc.ts";
import { lintQuarto } from "./qmd.ts";
import { lintRST } from "./rst.ts";
import { lintTypst } from "./typst.ts";
import { lintXML } from "./xml.ts";

export type { ADocHost } from "./adoc.ts";
export { lintADoc, parseAttributes, prepADoc } from "./adoc.ts";
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
export type { Comment, Language, Mask, ScannerDelims } from "./code/index.ts";
export {
	codeReady,
	getComments,
	getLanguageFromExt,
	hasLanguage,
	initCode,
	masked,
	scanComments,
	stripAt,
} from "./code/index.ts";
export type { CodeHost } from "./code.ts";
export {
	dropMasked,
	lintCode,
	lintCodeOld,
	lintComment,
	maskURLs,
	rstBatch,
	skipsComment,
	updateQueries,
} from "./code.ts";
export type { DataHost } from "./data.ts";
export {
	hasCodeView,
	hasView,
	isRuleFile,
	lintAsCode,
	lintData,
	lintDataComments,
	lintRule,
} from "./data.ts";
export type { DITAHost } from "./dita.ts";
export {
	clearDITA,
	commonDir,
	lintDITA,
	lintDITAHTML,
	prepareDITA,
} from "./dita.ts";
export { executeWithInput } from "./external.ts";
export type { FragmentHost } from "./fragment.ts";
export { adjustAlerts, commentPadding, lintFragments } from "./fragment.ts";
export type { HTMLHost } from "./html.ts";
export { lintHTML, textToHTML } from "./html.ts";
export type { LintResult } from "./lint.ts";
export { DocumentErrors, Linter } from "./lint.ts";
export { mathCloserIndex, mathPlugin } from "./math.ts";
export type { MarkdownHost } from "./md.ts";
export { lintMarkdown, lintMarkdownWith, newMarkdown, prepMarkdown } from "./md.ts";
export type { MaskSpan, MDXHost } from "./mdx.ts";
export {
	className,
	jsxTagSpans,
	lintMDX,
	maskSpans,
	newMDX,
	opensJsx,
} from "./mdx.ts";
export type { MetadataHost } from "./metadata.ts";
export { lintMetadata } from "./metadata.ts";
export type { MySTHost } from "./myst.ts";
export { lintMyST, newMyST } from "./myst.ts";
export type { NotebookHost } from "./notebook.ts";
export { lintNotebook } from "./notebook.ts";
export type { OrgHost } from "./org.ts";
export { lintOrg, orgToHTML } from "./org.ts";
export type { ExtensionConfig } from "./patterns.ts";
export {
	applyPatterns,
	BLOCK_DELIMITERS,
	hasPatterns,
	INLINE_DELIMITERS,
	sectionMatches,
} from "./patterns.ts";
export type { QDocHost } from "./qdoc.ts";
export {
	lintQDoc,
	lintQDocFragment,
	qdocFragmentToHTML,
	qdocToHTML,
} from "./qdoc.ts";
export type { QuartoHost } from "./qmd.ts";
export { lintQuarto, newQuarto, quartoClasses } from "./qmd.ts";
export type { RSTHost } from "./rst.ts";
export {
	convertRSTBatch,
	lintRST,
	lintRSTHTML,
	prepareRST,
	rstBody,
	rstExe,
	rstInterpreter,
} from "./rst.ts";
export type { ScopedHost } from "./scoped.ts";
export { isCode, lintScopedValues, placeAlerts } from "./scoped.ts";
export { markSelections, wrapQuotes, wrapSections } from "./selection.ts";
export type { Attribute, Token } from "./tokenizer.ts";
export {
	getAttribute,
	Tokenizer,
	TokenType,
	unescapeEntities,
} from "./tokenizer.ts";
export type { TypstHost } from "./typst.ts";
export { lintTypst } from "./typst.ts";
export {
	adjustPos,
	countNewlines,
	distance,
	findBestLineBySubstring,
	findLine,
	findLineBySubstring,
	leadingSpaces,
	similarity,
} from "./util.ts";
export type { Aggregate, InlineCapture } from "./walker.ts";
export { isMask, scopeSafe, trimASCII, Walker } from "./walker.ts";
export type { XMLHost } from "./xml.ts";
export { lintXML, XSLT_ARGS } from "./xml.ts";

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

	// The markup formats with a converter of their own.
	linter.register(".adoc", (f: File) => lintADoc(linter, f));
	linter.register(".dita", (f: File) => lintDITA(linter, f));
	linter.register(".ipynb", (f: File) => lintNotebook(linter, f));
	linter.register(".mdx", (f: File) => lintMDX(linter, f));
	linter.register(".myst", (f: File) => lintMyST(linter, f));
	linter.register(".org", (f: File) => lintOrg(linter, f));
	linter.register(".qdoc", (f: File) => lintQDoc(linter, f));
	linter.register(".qmd", (f: File) => lintQuarto(linter, f));
	linter.register(".rst", (f: File) => lintRST(linter, f));
	linter.register(".typ", (f: File) => lintTypst(linter, f));
	linter.register(".xml", (f: File) => lintXML(linter, f));
	linter.register(".xsd", (f: File) => lintXML(linter, f));

	// The three readings that are not a markup format: a source file read for
	// its comments, a source file whose comments hold markup, and a data file
	// read through a view. `lint.ts` dispatches to these by name.
	linter.register("code", (f: File) => lintCode(linter, f));
	linter.register("fragment", (f: File) => lintFragments(linter, f));
	linter.register("data", (f: File) => lintData(linter, f));
	linter.register("rule", (f: File) => lintRule(linter, f));

	// The three questions `read` asks before it dispatches on format. They are
	// hooks rather than methods because the answer depends on the views and the
	// rule shape, which the readers own.
	linter.hasView = (f: File) => hasView(linter.config, f);
	linter.hasCodeView = (f: File) => hasCodeView(linter.config, f);
	linter.isRuleFile = (f: File) => isRuleFile(f);

	for (const extend of READER_EXTENSIONS) extend(linter);

	return linter;
}

/**
 * `createLinter`, with the tree-sitter grammars loaded.
 *
 * Use this unless you have already awaited `initCode` yourself: reading a
 * source file's comments is the one thing in this package that cannot be set
 * up on demand.
 */
export async function createLinterAsync(manager: Manager): Promise<Linter> {
	await initCode();
	return createLinter(manager);
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
