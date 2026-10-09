/**
 * What every rule has in common: the `Rule` interface, the `Definition` each
 * rule carries, and the shared machinery for turning a YAML definition into a
 * pattern and a match into an alert.
 */

import {
	type Action,
	type Alert,
	type Block,
	type Config,
	emptyAction,
	type File,
	formatMessage,
	isPhrase,
	newE100,
	newE201FromPosition,
	newE201FromTarget,
	termPattern,
	toSentence,
	type ValeError,
} from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";
import { parseDocument } from "yaml";
import { fixAlert } from "./action.ts";
import type { BaseCheck } from "./decode.ts";
import { FieldError, Fields } from "./decode.ts";
import { matchCase } from "./matchcase.ts";
import { docSelectors, newSelector, type Selector } from "./scope.ts";
import { compileSelector } from "./selector.ts";
import { stringInSlice } from "./util.ts";

export type { BaseCheck };

/** Copies a rule definition, so a built-in one is never changed. */
export function cloneRule(generic: BaseCheck): BaseCheck {
	return { ...generic };
}

/** An individual writing construct to enforce. */
export interface Rule {
	run(blk: Block, file: File | null, cfg: Config | null): Alert[];
	fields(): Definition;
	pattern(): string;
}

/** The attributes every rule definition carries. */
export interface Definition {
	action: Action;
	description: string;
	/** The extension point, such as `existence`. */
	extends: string;
	level: string;
	limit: number;
	link: string;
	message: string;
	name: string;
	scope: string[];
	selector: Selector;

	/**
	 * `matchcase` (`bool`): adapt the replacement to the case of the text it
	 * replaces, so a rule written as `A-OK` still suggests `a-ok` for `a ok`.
	 *
	 * Meaningful wherever a rule swaps matched text for a literal the author
	 * wrote, since the author cannot know in advance how it will be cased.
	 * `capitalization` ignores it: that rule is about case, and re-casing its
	 * suggestion to match what it found would undo the correction.
	 */
	matchCase: boolean;
}

/** The environment the `--filter` flag is evaluated against. */
export interface FilterEnv {
	Rules: Array<Record<string, unknown>>;
}

export function newDefinition(partial: Partial<Definition> = {}): Definition {
	return {
		action: emptyAction(),
		description: "",
		extends: "",
		level: "",
		limit: 0,
		link: "",
		message: "",
		name: "",
		scope: [],
		selector: newSelector([]),
		matchCase: false,
		...partial,
	};
}

/** Reads the shared attributes, leaving the rule's own fields to the rule. */
export function readDefinition(f: Fields): Definition {
	const def = newDefinition({
		action: f.action("action"),
		description: f.string("description"),
		extends: f.string("extends"),
		level: f.string("level"),
		limit: f.int("limit"),
		link: f.string("link"),
		message: f.string("message"),
		name: f.string("name"),
		scope: f.strings("scope"),
		matchCase: f.bool("matchcase"),
	});
	// `selector` is set by the linter rather than written in a file, but the
	// key is still one the type knows -- which is what keeps a rule that
	// carries it from being refused as unrecognized.
	f.ignore("selector");
	return def;
}

export const DEFAULT_STYLES = ["Vale"];

export const EXTENSION_POINTS = [
	"capitalization",
	"conditional",
	"consistency",
	"existence",
	"occurrence",
	"repetition",
	"substitution",
	"readability",
	"spelling",
	"sequence",
	"metric",
	"script",
];

/** The rules Vale defines itself, which never come off disk. */
export const DEFAULT_RULES: Record<string, BaseCheck> = {
	Avoid: {
		extends: "existence",
		name: "Vale.Avoid",
		level: "error",
		message: "Avoid using '%s'.",
		scope: "text",
		ignorecase: false,
		tokens: [] as string[],
		path: "internal",
	},
	Terms: {
		extends: "substitution",
		name: "Vale.Terms",
		level: "error",
		message: "Use '%s' instead of '%s'.",
		scope: "text",
		ignorecase: true,
		swap: {} as Record<string, string>,
		vocab: false,
		path: "internal",
	},
	Repetition: {
		extends: "repetition",
		name: "Vale.Repetition",
		level: "error",
		message: "'%s' is repeated!",
		scope: "text",
		ignorecase: true,
		alpha: true,
		action: { name: "edit", params: ["truncate", " "] },
		tokens: [String.raw`[^\s.!?]+`],
		path: "internal",
	},
	Spelling: {
		extends: "spelling",
		name: "Vale.Spelling",
		message: "Did you really mean '%s'?",
		level: "error",
		scope: "text",
		action: { name: "suggest", params: ["spellings"] },
		ignore: [] as unknown[],
		path: "internal",
	},
};

export const IGNORE_CASE = "(?i)";
export const WORD_TEMPLATE = String.raw`(?m)\b(?:%s)\b`;
export const NONWORD_TEMPLATE = String.raw`(?m)(?:%s)`;
export const TOKEN_TEMPLATE = "^(?:%s)$";

/**
 * The accepted terms a file's sections add to the project's, compiled once per
 * set of vocabularies.
 */
export class SectionVocab {
	constructor(
		readonly exceptRe: Regexp | null,
		readonly phraseRe: Regexp | null,
	) {}

	/**
	 * Whether the sections accept `word`, or the phrase it sits in at `loc`
	 * within `txt`.
	 */
	accepts(word: string, txt: string, loc: readonly number[] | null): boolean {
		if (isMatch(this.exceptRe, word)) return true;
		if (loc === null) return false;
		return withinPhrase(this.phraseRe, txt, loc);
	}
}

/** The terms `f`'s sections accept, or null. */
export function vocabFor(cfg: Config | null, f: File | null): SectionVocab | null {
	if (f === null || cfg === null || f.vocab.length === 0) return null;
	const key = `vocab\u0000${f.vocab.join("\u0000")}`;
	return cfg.cached(key, () => {
		const terms: string[] = [];
		for (const name of f.vocab) {
			const vocab = cfg.vocabularies[name];
			if (vocab !== undefined) terms.push(...vocab.accepted);
		}
		let re: Regexp | null;
		try {
			re = updateExceptions([], terms, true);
		} catch {
			re = null;
		}
		return new SectionVocab(re, buildPhraseRe([], terms, true));
	});
}

/** Whether a section vocabulary accepts a word, with a null check folded in. */
export function vocabAccepts(
	v: SectionVocab | null,
	word: string,
	txt: string,
	loc: readonly number[] | null,
): boolean {
	return v !== null && v.accepts(word, txt, loc);
}

/** Whether `r` matches `s`; a rule with no exceptions has no pattern. */
export function isMatch(r: Regexp | null, s: string): boolean {
	if (r === null || r.pattern === "") return false;
	try {
		return r.test(s);
	} catch {
		return false;
	}
}

export function formatMessages(
	msg: string,
	desc: string,
	...subs: string[]
): [string, string] {
	return [formatMessage(msg, ...subs), formatMessage(desc, ...subs)];
}

/**
 * The text of a span of a block.
 *
 * Go needs this because `regexp2` reports its locations in *rune* offsets
 * while its strings are indexed in bytes. This port has one offset unit, the
 * JavaScript string index, so nothing is converted -- what is left is the
 * bounds check, which every caller depends on, and the slice.
 */
export function re2Loc(blk: Block, loc: readonly number[]): string {
	const [lo, hi, ok] = blk.byteSpan(loc[0]!, loc[1]!);
	if (!ok) {
		throw newE100(
			"internal",
			new Error(`match out of bounds: ${blk.text.length} (${loc[0]}:${loc[1]})`),
		);
	}
	return blk.text.slice(lo, hi);
}

export function makeAlert(
	chk: Definition,
	loc: number[],
	blk: Block,
	cfg: Config | null,
): Alert {
	return alertFor(chk, loc, re2Loc(blk, loc), cfg);
}

/**
 * Builds an alert from a span whose text the caller already has.
 *
 * Cutting the matched text out of the block is work every caller of
 * `makeAlert` had already done to inspect it, so one that has should not pay
 * for it twice.
 */
export function alertFor(
	chk: Definition,
	loc: number[],
	match: string,
	cfg: Config | null,
): Alert {
	return alertWithGroups(chk, loc, match, null, cfg);
}

/**
 * `alertFor` with the matched token's capture groups, which an action's
 * arguments may refer to.
 */
export function alertWithGroups(
	chk: Definition,
	loc: number[],
	match: string,
	groups: string[] | null,
	cfg: Config | null,
): Alert {
	const action: Action = { name: chk.action.name, params: [...chk.action.params] };
	if (chk.matchCase && action.name === "replace") {
		action.params = action.params.map((p) => matchCase(p, match));
	}

	const a: Alert = {
		check: chk.name,
		severity: chk.level,
		span: loc,
		link: chk.link,
		match,
		action,
		description: "",
		message: "",
		line: 0,
		suggestions: [],
	};
	if (groups !== null) a.groups = groups;

	if (chk.action.name !== "") {
		let repl = match;

		let fixed: string[];
		try {
			fixed = fixAlert(a, cfg);
		} catch (err) {
			throw new Error(
				`${chk.name}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		a.suggestions = fixed;

		if (fixed.length === 1) repl = fixed[0]!;
		else if (fixed.length > 1) repl = toSentence(fixed, "or");

		[a.message, a.description] = formatMessages(
			chk.message,
			chk.description,
			match,
			repl,
		);
	} else {
		[a.message, a.description] = formatMessages(
			chk.message,
			chk.description,
			match,
		);
	}

	return a;
}

/**
 * Builds the pattern a rule's tokens go into.
 *
 * The result is a format string the caller fills with its tokens, so a `%` in
 * the raw text has to survive that step.
 */
export function makeRegexp(
	template: string,
	noCase: boolean,
	word: () => boolean,
	callback: () => string,
	shouldAppend: boolean,
): string {
	let regex = "";

	if (word()) regex += template !== "" ? template : WORD_TEMPLATE;
	else regex += NONWORD_TEMPLATE;

	const raw = callback().replaceAll("%", "%%");
	if (shouldAppend) regex += raw;
	else regex = raw + regex;

	if (noCase) regex = IGNORE_CASE + regex;

	return regex;
}

/** Fills the one `%s` of a pattern template, as Go's `fmt.Sprintf` does. */
export function fillTemplate(template: string, value: string): string {
	let filled = false;
	return template.replace(/%(%|s|v)/g, (m) => {
		if (m === "%%") return "%";
		if (filled) return m;
		filled = true;
		return value;
	});
}

/**
 * Whether `observed` already conforms to `expected`.
 *
 * A plain phrase is compared exactly; anything else is read as a pattern, as a
 * vocabulary term such as `[pP]y.*\b` has to be.
 */
export function matchToken(
	expected: string,
	observed: string,
	ignorecase: boolean,
): boolean {
	const p = ignorecase ? IGNORE_CASE + expected : expected;

	let r: Regexp | null = null;
	try {
		r = Regexp.compile(fillTemplate(TOKEN_TEMPLATE, p));
	} catch {
		r = null;
	}
	if (isPhrase(expected) || r === null) return expected === observed;
	return r.test(observed);
}

/**
 * The pattern matching a rule's exceptions, plus the project's accepted terms
 * when the rule reads them.
 */
export function updateExceptions(
	previous: readonly string[],
	current: readonly string[],
	vocab: boolean,
): Regexp | null {
	const terms = vocab ? [...previous, ...current] : [...previous];

	// Greedy alternation: a regular-expression alternation takes the first
	// branch that matches, so the longest term has to come first.
	terms.sort((a, b) => b.length - a.length);

	// `(?-i)` is added to each term that does not already carry `(?i)`,
	// because one term's `(?i)` would otherwise set the flag for the whole
	// expression.
	const parts = terms.map((raw) => {
		const term = termPattern(raw);
		return term.startsWith("(?i)") ? term : `(?-i)${term}`;
	});

	if (parts.length === 0) return null;

	const regex = makeRegexp(
		"",
		false,
		() => true,
		() => "",
		true,
	);
	return Regexp.compile(fillTemplate(regex, parts.join("|")));
}

/**
 * The pattern matching the multi-word entries among the exception terms.
 *
 * It lets a rule suppress a finding that falls within an accepted phrase even
 * when the rule matched only one of the phrase's component words -- `mea`
 * within an accepted `mea culpa`.
 *
 * Null when there are no multi-word terms, or when one fails to compile, in
 * which case `updateExceptions` surfaces the error.
 */
export function buildPhraseRe(
	previous: readonly string[],
	current: readonly string[],
	vocab: boolean,
): Regexp | null {
	const terms = vocab ? [...previous, ...current] : [...previous];

	const phrases: string[] = [];
	for (const term of terms) {
		if (term.includes(" ") || term.includes("\t") || term.includes("\\s")) {
			phrases.push(termPattern(term));
		}
	}

	if (phrases.length === 0) return null;

	try {
		return Regexp.compile(`${IGNORE_CASE}\\b(?:${phrases.join("|")})\\b`);
	} catch {
		return null;
	}
}

/**
 * Whether the span `loc` falls entirely within a match of `phraseRe` -- an
 * accepted multi-word phrase -- in `txt`.
 */
export function withinPhrase(
	phraseRe: Regexp | null,
	txt: string,
	loc: readonly number[],
): boolean {
	if (phraseRe === null) return false;
	for (const span of phraseRe.findAllStringIndex(txt, -1)) {
		if (loc[0]! >= span[0] && loc[1]! <= span[1]) return true;
	}
	return false;
}

/** Reads a rule definition out of YAML, and checks what every rule must have. */
export function parseDefinition(file: string, path: string): BaseCheck {
	const generic = parseYAMLDefinition(file, path);
	validateDefinition(generic, path);
	return generic;
}

/** Whether an `extends` value names a rule rather than an extension point. */
export function isRuleRef(extendsValue: string): boolean {
	return extendsValue.includes(".");
}

export function validateDefinition(generic: BaseCheck, path: string): void {
	const point = generic.extends;
	if (point === undefined || point === null) {
		throw newE201FromPosition("Missing the required 'extends' key.", path, 1);
	}
	const key = typeof point === "string" ? point : "";
	if (!stringInSlice(key, EXTENSION_POINTS) && !isRuleRef(key)) {
		// A dotted value names another rule to extend; `inherit.ts` resolves it
		// before `buildRule`, which only ever sees an extension point.
		throw newE201FromTarget(
			`'extends' key must be one of [${EXTENSION_POINTS.join(" ")}].`,
			key,
			path,
		);
	}

	if (!Object.hasOwn(generic, "message")) {
		// A rule extending another rule inherits its message unless it says
		// otherwise; the chain's root is still held to this when it parses.
		if (!isRuleRef(key)) {
			throw newE201FromPosition("Missing the required 'message' key.", path, 1);
		}
	}

	if (Object.hasOwn(generic, "level")) {
		const level = generic.level;
		if (
			level === null ||
			typeof level !== "string" ||
			!["suggestion", "warning", "error"].includes(level)
		) {
			throw newE201FromTarget(
				"'level' must be one of [suggestion warning error]",
				"level",
				path,
			);
		}
	}

	if (generic.code === true) {
		throw newE201FromTarget(
			"`code` is deprecated; please use `scope: raw` instead.",
			"code",
			path,
		);
	}
}

/** Turns a failed field read into an error that points at the key. */
export function readStructureError(err: unknown, path: string): ValeError {
	if (err instanceof FieldError) {
		return newE201FromTarget(err.detail, err.key.toLowerCase(), path);
	}
	return newE201FromPosition(
		err instanceof Error ? err.message : String(err),
		path,
		1,
	);
}

/** Checks a rule's declared scopes before anything tries to match them. */
export function checkScopes(scopes: readonly string[], path: string): void {
	for (const declared of scopes) {
		for (const sel of docSelectors(declared)) {
			try {
				compileSelector(sel);
			} catch (err) {
				throw newE201FromTarget(
					`invalid selector in 'doc(...)': ${err instanceof Error ? err.message : String(err)}`,
					"scope",
					path,
				);
			}
		}
		if (
			declared.includes("&") ||
			(declared.startsWith("~") ? declared.slice(1) : declared).startsWith("doc(")
		) {
			// A chained or selector-bearing scope is checked term by term
			// above; the spelling rules below are about a single name.
			continue;
		}

		// Negation, then specification: only the family name is checked.
		const bare = declared.startsWith("~") ? declared.slice(1) : declared;
		const scope = bare.split(".")[0]!;

		if (scope.includes(" ")) {
			throw newE201FromTarget(`scope '${scope}' contains spaces.`, "scope", path);
		}
	}
}

/** The YAML reading, kept apart so the error positions stay in one place. */
function parseYAMLDefinition(file: string, path: string): BaseCheck {
	const doc = parseDocument(file);
	if (doc.errors.length > 0) {
		const first = doc.errors[0]!;
		throw newE201FromPosition(first.message, path, lineOf(file, first.pos[0]));
	}
	const value = doc.toJS({ maxAliasCount: 100 }) as unknown;
	if (value === null || value === undefined) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw newE201FromPosition("a rule is a mapping of keys to values", path, 1);
	}
	return value as BaseCheck;
}

function lineOf(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < src.length; i++) {
		if (src[i] === "\n") line++;
	}
	return line;
}

export { Fields };
