/**
 * Reading a source file's comments with tree-sitter.
 *
 * `lang.ts` says which grammar a file is parsed with and what its comments
 * look like, `query.ts` turns a captured node into a comment, `scanner.ts`
 * does the same by delimiter for the languages with no grammar, `doc.ts` holds
 * the documentation conventions, and `comments.ts` ties them together.
 *
 * `initCode` must be awaited once before any of this is used; see `lang.ts`.
 */

export type { Mask } from "./doc.ts";
export {
	goDoc,
	goDocName,
	javadoc,
	jsDoc,
	kDoc,
	leadingMask,
	pyDoc,
	rustDoc,
} from "./doc.ts";
export { appendLine, attachRun, coalesce, getComments } from "./comments.ts";
export {
	codeReady,
	getLanguageFromExt,
	hasLanguage,
	initCode,
	SCANNED,
} from "./lang.ts";
export { CommentBuilder, commonIndent, QueryEngine, stripIndent } from "./query.ts";
export { scanComments } from "./scanner.ts";
export type { Comment, Language, ScannerDelims } from "./types.ts";
export { masked, stripAt } from "./types.ts";
export { C_STYLE_PREFIX, computePadding, cStyle } from "./util.ts";
