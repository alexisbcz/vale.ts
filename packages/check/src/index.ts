/**
 * `@vale-ts/check` -- Vale's rule types and the scope selectors they run in.
 *
 * A rule is a YAML definition that names an *extension point* -- `existence`,
 * `substitution`, `sequence` and the rest -- and the keys that point needs.
 * This package reads those definitions, compiles them, and runs them against
 * the blocks `@vale-ts/lint` produces.
 *
 * ```ts
 * import { Manager, newScope } from "@vale-ts/check";
 *
 * const mgr = Manager.create(config);
 * for (const [name, rule] of mgr.rules()) {
 *   if (newScope(rule.fields().scope).matches(block)) rule.run(block, file, config);
 * }
 * ```
 *
 * # Offsets
 *
 * There is one offset unit: the JavaScript string index. Go's checks work in
 * rune offsets, which its blocks convert to bytes; here both are the same
 * number, so `re2Loc` is a bounds check rather than a conversion.
 */

export type { Action, Solution } from "./action.ts";
export {
	checkAction,
	clearScriptCache,
	editSteps,
	fixAlert,
	flattenAction,
	hasCompiledScript,
	parseAlert,
	resolveFix,
} from "./action.ts";
export type { ExpandFunc } from "./affix.ts";
export {
	affixExpander,
	affixToken,
	affixTokens,
	findAffix,
	registerSpeller,
} from "./affix.ts";
export { anchor, runeSpanToBytes } from "./anchor.ts";
export { buildRule } from "./build.ts";
export { Capitalization } from "./capitalization.ts";
export { Conditional, hasCaptureGroup } from "./conditional.ts";
export { Consistency } from "./consistency.ts";
export type { BaseCheck } from "./decode.ts";
export { FieldError, Fields } from "./decode.ts";
export type { Definition, FilterEnv, Rule } from "./definition.ts";
export {
	alertFor,
	alertWithGroups,
	buildPhraseRe,
	checkScopes,
	cloneRule,
	DEFAULT_RULES,
	DEFAULT_STYLES,
	EXTENSION_POINTS,
	fillTemplate,
	formatMessages,
	IGNORE_CASE,
	isMatch,
	isRuleRef,
	makeAlert,
	makeRegexp,
	matchToken,
	NONWORD_TEMPLATE,
	newDefinition,
	parseDefinition,
	re2Loc,
	readDefinition,
	readStructureError,
	SectionVocab,
	TOKEN_TEMPLATE,
	updateExceptions,
	validateDefinition,
	vocabAccepts,
	vocabFor,
	WORD_TEMPLATE,
	withinPhrase,
} from "./definition.ts";
export {
	capitalize,
	cardinalWords,
	dumbPunctuation,
	expandGroups,
	numberToWords,
	ordinalSuffix,
	ordinalWord,
	ordinalWords,
	smartPunctuation,
	squeeze,
	toASCII,
	uncapitalize,
	wordsToNumber,
} from "./editops.ts";
export { Existence, groupSpans } from "./existence.ts";
export { filter, filterView } from "./filter.ts";
export { editField, flatten, overlay, resolveRule } from "./inherit.ts";
export type { Selection } from "./manager.ts";
export { Manager, paramValue } from "./manager.ts";
export { matchCase, recase, words } from "./matchcase.ts";
export {
	checkExpression,
	evalMath,
	Metric,
	measuredScope,
	round,
	ruleError,
	TENGO_TIMEOUT_MS,
} from "./metric.ts";
export { Occurrence } from "./occurrence.ts";
export { patternError } from "./pattern-error.ts";
export { Readability } from "./readability.ts";
export { Repetition } from "./repetition.ts";
export type { ScopeMatcher } from "./scope.ts";
export {
	cachedSelector,
	docID,
	docSelectorMap,
	docSelectors,
	expandScopes,
	INLINE_SCOPES,
	newScope,
	newSelector,
	Scope,
	Selector,
	scopeBases,
	splitOutside,
} from "./scope.ts";
export { parseMatches, Script, sourceSpan } from "./script.ts";
export type { DocMatcher } from "./selector.ts";
export {
	compileSelector,
	portableSelector,
	standardSelector,
} from "./selector.ts";
export type { NLPToken } from "./sequence.ts";
export {
	Sequence,
	sentenceScope,
	sequenceMatches,
	stepsToString,
	tokensMatch,
} from "./sequence.ts";
export type { IdentifierPart } from "./spellfilter.ts";
export {
	DEFAULT_FILTERS,
	skippedByDefault,
	skipsCamel,
	skipsNonIdentifier,
	skipsNonWord,
	skipsTrailingCaps,
	splitIdentifier,
} from "./spellfilter.ts";
export { certainRecase, Spelling } from "./spelling.ts";
export * as strcase from "./strcase.ts";
export {
	convertCaptureGroups,
	convertMessage,
	expandPattern,
	getOptions,
	keepWrap,
	literalSkeleton,
	recaseToTerm,
	Substitution,
	sharedLookaround,
} from "./substitution.ts";
export { tokensWith } from "./tokens.ts";
export { uposNames, uposTagPattern, uposWordPattern } from "./upos.ts";
export {
	allStringsInSlice,
	fnv32a,
	goStringsTitle,
	intInSlice,
	stringInSlice,
} from "./util.ts";
export type { CheckFunc } from "./variables.ts";
export {
	lower,
	READABILITY_METRICS,
	sentence,
	title,
	upper,
	VAR_TO_FUNC,
	wasIndicator,
	wordsIn,
} from "./variables.ts";
