/**
 * `@vale-ts/core` -- Vale's configuration model, alert types, file model and
 * the arithmetic that turns a match into a line and a column.
 *
 * This is the layer everything else is built on. The rule types live in
 * `@vale-ts/check`, the readers that turn a document into blocks live in
 * `@vale-ts/lint`, and `vale-ts` ties the three together.
 *
 * # One offset unit
 *
 * Go counts bytes in some places and runes in others, and converts between
 * them. This port has one offset unit -- the JavaScript string index, a UTF-16
 * code unit -- used wherever Go uses a byte offset. Columns are the exception:
 * a column is a count of characters, which `strLen` returns.
 */

export type { Action, Alert, AlertLevel, Span } from "./alert.ts";
export {
	ALERT_LEVELS,
	emptyAction,
	formatAlert,
	isAlertLevel,
	LEVEL_TO_INT,
	newAlert,
	sortAlerts,
	whitespaceToSpace,
} from "./alert.ts";
export type { Inline, NLPInfo, Run, Segmenter } from "./block.ts";
export { Block, blankRunes, computeBlocks, newNLPInfo } from "./block.ts";
export type { FileFields } from "./condition.ts";
export { Condition, newFileFields, relToRoot, splitSection } from "./condition.ts";
export type { CLIFlags } from "./config.ts";
export {
	ACTION_DIR,
	CONFIG_DIR,
	CONFIG_DIRS,
	CONFIG_VARS,
	Config,
	DICT_DIR,
	defaultConfig,
	defaultStylesPath,
	emptyINI,
	FILTER_DIR,
	findAffix,
	findAsset,
	findConfigAsset,
	findLocalConfig,
	fromFile,
	fromString,
	getPackages,
	IGNORE_DIR,
	ignoreFiles,
	loadInto,
	loadVocabulary,
	mockLoad,
	newConfig,
	newFlags,
	PIPE_DIR,
	packageOf,
	parseINI,
	processConfig,
	readPipeline,
	SCOPE_DIR,
	SCRIPT_DIR,
	splitEscaped,
	TMPL_DIR,
	VIEW_DIR,
	VOCAB_DIR,
} from "./config.ts";
export type { ErrorCondition, ExcerptLine, WarnSink } from "./errors.ts";
export {
	newE100,
	newE201,
	newE201FromKey,
	newE201FromPosition,
	newE201FromTarget,
	setWarnSink,
	ValeError,
	warn,
} from "./errors.ts";
export type { Environment, Value } from "./expr.ts";
export { compileExpr, ExprError, Expression, truthy } from "./expr.ts";
export { File, newFile } from "./file.ts";
export {
	COMMENTS_BY_NORMED_EXT,
	FORMAT_BY_EXTENSION,
	formatFor,
	formatFromExt,
	getFormat,
	getNormedExt,
	isTestFile,
	normalizePathFormat,
	TEST_FILE_SUFFIXES,
} from "./format.ts";
export type { FrontMatter } from "./frontmatter.ts";
export {
	frontMatterValues,
	parseFrontMatter,
	positionOf,
} from "./frontmatter.ts";
export { compileGlob, Glob } from "./glob.ts";
export { selectStrings, selectValues } from "./dasel.ts";
export type { Cell } from "./notebook.ts";
export { describeCell, KERNEL_EXTS, parseNotebook } from "./notebook.ts";
export type { ScalarPos, ScalarResolver, Source } from "./structured.ts";
export {
	blockScalarContentStart,
	fileToValue,
	foldedToLiteral,
	newPart,
	newScalarResolver,
	newSource,
	positionAt,
	scalarAt,
	walkYAMLScalars,
} from "./structured.ts";
export type { Capture, Value as TextFSMValue } from "./textfsm.ts";
export { joinCaptures, parseTemplate, Template } from "./textfsm.ts";

export type { LoadOptions } from "./ini.ts";
export { DEFAULT_SECTION, File as INIFile, Key, Section } from "./ini.ts";
export type { Located } from "./location.ts";
export {
	countPrior,
	directPosition,
	initialPosition,
	insideInlineMarkup,
	isPunctOnly,
	lineStarts,
	literalNth,
	locateMatch,
	locFromOffset,
	maskedOffset,
	maskMatch,
	quoteTolerantPattern,
	spanAt,
	throughMask,
	upperBound,
} from "./location.ts";
export type { Metrics } from "./metrics.ts";
export { blockMetrics, sentenceLengthSD } from "./metrics.ts";
export { literalTerm, quoteMetaLike, termPattern } from "./patterns.ts";
export { loadScopeFile, RESERVED_SCOPES } from "./scopes.ts";
export type { WalkEntry } from "./system.ts";
export {
	absPath,
	determinePath,
	fileExists,
	fileNameWithoutExt,
	isDir,
	isLinux,
	isMac,
	isUnix,
	isWindows,
	mkdir,
	normalizePath,
	osName,
	platformAndArch,
	relToWD,
	walk,
	which,
	xdg,
} from "./system.ts";
export {
	baseName,
	capFirst,
	checkName,
	DEFAULT_IGNORE_DIRECTORIES,
	dirName,
	extName,
	findShifts,
	formatMessage,
	hasAnySuffix,
	indent,
	inRange,
	isAbsolute,
	isCode,
	isLetter,
	isPhrase,
	joinPath,
	RSQUO_SHIFT,
	relativePath,
	sanitize,
	shouldIgnoreDirectory,
	splitAfterLines,
	stripANSI,
	strLen,
	styleName,
	substitute,
	toSentence,
	toSlash,
	uniqueStrings,
} from "./util.ts";
export type {
	Part,
	Scope,
	ScopedValue,
	ScopedValues,
	ViewTarget,
} from "./view.ts";
export { locateInValue, newView, parseView, View } from "./view.ts";
export type {
	AffixFinder,
	AffixResolver,
	ExpandFunc,
	Vocabulary,
} from "./vocab.ts";
export {
	BUILTIN_AFFIX,
	newVocabulary,
	parseVocabYAML,
	parseWordList,
	readVocabYAML,
	readWordList,
	setAffixResolver,
	VOCAB_FILES,
} from "./vocab.ts";
