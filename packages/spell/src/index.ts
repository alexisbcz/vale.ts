/**
 * A high-performance spell checker based on Hunspell-compatible
 * dictionaries.
 *
 * This is a port of Vale's `internal/spell`, which began as gospell (MIT,
 * Nick Galbreath; see LICENSE.gospell) and grew the parts of Hunspell that a
 * prose linter needs: affix expansion with cross-products and continuation
 * classes, Hunspell's case rules, compounding by rule and by flag, BREAK
 * splitting, and a suggester ranked the way Hunspell ranks.
 *
 * # Using it without a file system
 *
 * Nothing here has to touch disk. `newGoSpellReader` takes a `.aff` and
 * `.dic` as text, `expandWithContent` takes an affix file as text, and
 * `usingDictionaryText` adds one to a `Checker`; a bundle that inlines the
 * built-in dictionary hands it in with `setBuiltinDictionary`. The functions
 * that do read files -- `newGoSpell`, `expandWith`, `addWordListFile` and
 * `Checker.loadDic` -- each have a sibling that takes the content instead,
 * and they read through `node:fs`, so they behave the same under Bun and
 * Node.
 *
 * # Offsets
 *
 * Where Go indexes a string by byte this port indexes it by UTF-16 code unit,
 * and where Go counts runes it counts code points. A Hunspell flag is the
 * exception: Hunspell reads one out of a UTF-8 file byte by byte, so
 * `text.ts` keeps those bytes as a Latin-1 string and the `.aff` and the
 * `.dic` agree on which flag is which.
 */

export type {
	Affix,
	AffixType,
	CompoundPattern,
	EntryForm,
	ReverseIndex,
	Rule,
	RuleToken,
	Segment,
} from "./aff.ts";
export {
	conditionPattern,
	DictConfig,
	defaultCompoundMin,
	Expander,
	hasFlag,
	maxAffixDepth,
	newDictConfig,
	Prefix,
	Suffix,
} from "./aff.ts";
export {
	builtinAffix,
	builtinDictionary,
	builtinName,
	setBuiltinDictionary,
} from "./builtin.ts";
export type { DecodedDictionary } from "./encoding.ts";
export { decodeDictionary, decodeDictionaryText } from "./encoding.ts";
export { expand, expandWith, expandWithContent } from "./expand.ts";
export type { CaseStyle, WordMatch } from "./gospell.ts";
export {
	allUpper,
	classifyCase,
	GoSpell,
	initialUpper,
	newGoSpell,
	newGoSpellBytes,
	newGoSpellReader,
	splitEntry,
} from "./gospell.ts";
export type { Analyzer, RootEntry } from "./lazy.ts";
export { readings, reverseSet } from "./lazy.ts";
export type {
	CheckerOption,
	DictionaryPaths,
	DictionaryText,
	Options,
	Suggestion,
} from "./multi.ts";
export {
	Checker,
	clearDictionaryCache,
	newChecker,
	similarity,
	usingDictionary,
	usingDictionaryByPath,
	usingDictionaryText,
	withDefault,
	withDefaultPath,
	withPath,
} from "./multi.ts";
export { distance } from "./similarity.ts";
export { Splitter } from "./words.ts";
