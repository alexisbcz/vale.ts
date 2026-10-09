/**
 * `spelling`: checks a block's words against Hunspell dictionaries.
 */

import { isAbsolute, resolve } from "node:path";
import {
	type Alert,
	type Block,
	type Config,
	DICT_DIR,
	type File,
	fileExists,
	findAsset,
	IGNORE_DIR,
	ignoreFiles,
	isDir,
	joinPath,
	newE201FromPosition,
	termPattern,
} from "@vale-ts/core";
import { tokenizeWordsWithOffsets } from "@vale-ts/nlp";
import { Regexp } from "@vale-ts/regex";
import {
	type Checker,
	newChecker,
	type Suggestion,
	similarity,
	usingDictionary,
	usingDictionaryByPath,
	withDefault,
	withDefaultPath,
	withPath,
} from "@vale-ts/spell";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	buildPhraseRe,
	type Definition,
	formatMessages,
	IGNORE_CASE,
	isMatch,
	type Rule,
	readDefinition,
	readStructureError,
	vocabAccepts,
	vocabFor,
} from "./definition.ts";
import {
	type IdentifierPart,
	skippedByDefault,
	skipsNonIdentifier,
	splitIdentifier,
} from "./spellfilter.ts";

/** The shortest part of an identifier that is checked. */
const MIN_PART_LETTERS = 3;

/** How inline code is written, by format. */
const INLINE_CODE: Record<string, string> = {
	".md": "`%s`",
	".mdx": "`%s`",
	".myst": "`%s`",
	".qmd": "`%s`",
	".ipynb": "`%s`",
	".adoc": "`%s`",
	".typ": "`%s`",
	".rst": "``%s``",
	".org": "~%s~",
	".html": "<code>%s</code>",
};

/**
 * Matches snake_case, and lowerCamel with two or more leading lower-case
 * letters: `apiVersion`, but not `vSphere` or `iPhone`, which are names.
 */
const IDENTIFIER_SHAPE =
	/^(?:[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[a-z]{2,}[A-Z][A-Za-z0-9]*)$/;

export class Spelling implements Rule {
	private readonly definition: Definition;

	/** The user's own filters, compiled when the rule loads. */
	readonly filters: RegExp[] = [];

	/**
	 * Whether the built-in filters apply, which they do unless the rule
	 * declares `custom: true`.
	 */
	private stdFilters = false;

	readonly ignore: string[] = [];
	readonly exceptions: string[];
	readonly dictionaries: string[];
	readonly aff: string;
	readonly dic: string;
	readonly dicpath: string;
	readonly threshold: number;
	readonly custom: boolean;
	readonly append: boolean;

	/**
	 * `split` (`bool`): check the parts of an identifier -- `recieveMessage`,
	 * `recieve_message`, `RecieveMessage` -- rather than skipping it or
	 * checking it whole. A part is reported at its own position.
	 */
	readonly split: boolean;

	private readonly exceptRe: Regexp | null;
	private readonly phraseRe: Regexp | null;
	private readonly gs: Checker;

	constructor(cfg: Config | null, generic: BaseCheck, path: string) {
		const name = typeof generic.name === "string" ? generic.name : "";

		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);

			// Pre-compiled for speed: these run against every word of every
			// block, and compiling per call cost about four times the run.
			for (const filter of f.strings("filters")) {
				this.filters.push(new RegExp(filter, "u"));
			}

			// Accepted either as one string or as a list, for compatibility.
			this.ignore = f.strings("ignore");

			this.exceptions = f.strings("exceptions");
			this.dictionaries = f.strings("dictionaries");
			this.aff = f.string("aff");
			this.dic = f.string("dic");
			this.dicpath = f.string("dicpath");
			this.threshold = f.int("threshold");
			this.custom = f.bool("custom");
			this.append = f.bool("append");
			this.split = f.bool("split");
			// Read without refusing a key it does not know, as Go's
			// `WeakDecode` does here rather than `decodeRule`.
		} catch (err) {
			throw readStructureError(err, path);
		}

		const accepted = cfg?.acceptedTokens ?? [];

		// Whole words rather than substrings: for spell checking, a word that
		// is part of a larger word should still be checked.
		//
		// A spelling rule's own `exceptions` are deliberately not part of this
		// pattern, which is what Go builds here too -- the key is not among
		// the ones this check documents.
		const wrapped = accepted.map((term) => `\\b${termPattern(term)}\\b`);
		this.exceptRe =
			wrapped.length === 0
				? null
				: Regexp.mustCompile(IGNORE_CASE + wrapped.join("|"));

		// A multi-word term such as `mea culpa` is accepted only as a phrase;
		// its component words are still spell-checked on their own. These are
		// masked in `run`.
		this.phraseRe = buildPhraseRe([], accepted, true);

		let model: Checker;
		try {
			model = this.makeSpeller(cfg, path);
		} catch (err) {
			throw newE201FromPosition(
				err instanceof Error ? err.message : String(err),
				path,
				1,
			);
		}

		if (name === "Vale.Spelling") {
			// There is no way to name ignore files for the built-in rule, so
			// the default `config/ignore` directory is all it reads.
			//
			// Vocabularies cannot be added here, because a word list holds no
			// patterns and a vocabulary term may be one.
			for (const file of ignoreFiles(cfg?.stylesPath() ?? "")) {
				model.addWordListFile(file);
			}
		} else {
			for (const ignore of this.ignore) {
				const stylesPath = cfg?.stylesPath() ?? "";
				// Three readings, tried in turn: an absolute path as `$DICPATH`
				// would hold, a path relative to the styles path, and a name
				// under `config/ignore`.
				const paths = [
					isAbsolute(ignore) ? ignore : resolve(ignore),
					joinPath(stylesPath, ignore),
					joinPath(stylesPath, IGNORE_DIR, ignore),
				];
				for (const p of paths) {
					if (!fileExists(p)) continue;
					model.addWordListFile(p);
				}
			}
		}

		if (!this.custom) {
			// The defaults are answered by hand rather than by pattern -- see
			// `spellfilter.ts`. They are not added to `filters`, so a rule that
			// also declares its own runs those as patterns and these as code.
			this.stdFilters = true;
		}
		this.gs = model;
	}

	run(blk: Block, file: File | null, cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];
		const vocab = vocabFor(cfg, file);

		// Accepted multi-word phrases are masked so their component words are
		// not spell-checked individually, while the same words elsewhere still
		// are. Each match becomes an equal-length run of spaces, which keeps
		// every other word's offset.
		//
		// The block's own text is masked rather than a converted copy, so that
		// every offset below is one into `blk.text` and needs no translation.
		let checkTxt = blk.text;
		if (this.phraseRe !== null) {
			try {
				checkTxt = this.phraseRe.replaceFunc(
					blk.text,
					(m) => " ".repeat(m.text.length),
					-1,
					-1,
				);
			} catch {
				checkTxt = blk.text;
			}
		}

		// Each word's position comes back with it, which is what lets the alert
		// be placed by arithmetic instead of by searching the whole context for
		// its text once per alert. Searching also could not tell one occurrence
		// of a repeated word from another, and so reported the first every time.
		const { tokens: words, offsets } = tokenizeWordsWithOffsets(checkTxt);

		outer: for (let i = 0; i < words.length; i++) {
			const found = words[i]!;

			// Honours an `.aff` entry such as `ICONV ’ '`, which is what keeps
			// a curly apostrophe from reading as a misspelling.
			//
			// Applied per word, which is where Hunspell applies it, and what
			// keeps the offsets above measured against the text as written: the
			// conversions change length, so a position taken from a converted
			// copy of the block drifts further out of place with every one that
			// fires.
			const word = this.gs.convert(found);

			if (this.stdFilters && this.skipped(word)) continue;
			for (const filter of this.filters) {
				filter.lastIndex = 0;
				if (filter.test(word)) continue outer;
			}

			const offset = offsets[i]!;
			if (
				this.gs.spell(word) ||
				isMatch(this.exceptRe, word) ||
				vocabAccepts(vocab, word, checkTxt, [offset, offset + found.length])
			) {
				continue;
			}

			if (this.split) {
				// A plain word is reported whole; anything else is an
				// identifier, and only its parts are.
				const parts = splitIdentifier(found);
				if (parts.length !== 1 || parts[0]!.text !== found) {
					for (const part of parts) {
						if (
							this.checkPart(part.text) ||
							vocabAccepts(vocab, part.text, "", null)
						) {
							continue;
						}
						const a = this.alert(part.text, offset + part.at, part.text.length);
						// A part is not a whole word, so a search for it would
						// land elsewhere; the block knows where it is. Where it
						// does not, the whole identifier is reported instead.
						const at = blk.sourceOffset(offset + part.at);
						if (at >= 0) {
							a.span = [at, at + part.text.length];
							a.hasByteOffsets = true;
						} else {
							a.match = found;
							a.span = [offset, offset + found.length];
						}
						alerts.push(a);
					}
					continue;
				}
			}

			// The extent is the word as it appears, not as it converts: the
			// offset is a position in the block's own text, so the length that
			// goes with it has to be measured there too.
			const a = this.alert(word, offset, found.length);
			this.explain(a, word, found, file);
			// The block knows where it is, so the word need not be searched
			// for, which found an earlier copy of it or one in markup.
			const at = blk.sourceOffset(offset);
			if (at >= 0) {
				a.span = [at, at + found.length];
				a.hasByteOffsets = true;
			}
			alerts.push(a);
		}

		return alerts;
	}

	/**
	 * Whether the built-in filters skip a word.
	 *
	 * With `split`, an identifier is not skipped but taken apart, so only a
	 * word with a character no identifier holds is.
	 */
	private skipped(word: string): boolean {
		if (this.split) return skipsNonIdentifier(word);
		return skippedByDefault(word);
	}

	/**
	 * Whether one part of an identifier passes: a short part or an acronym is
	 * not checked.
	 */
	private checkPart(part: string): boolean {
		let letters = 0;
		for (const r of part) {
			if (/\p{L}/u.test(r)) letters++;
		}
		if (letters < MIN_PART_LETTERS || part.toUpperCase() === part) return true;
		return this.gs.spell(this.gs.convert(part)) || isMatch(this.exceptRe, part);
	}

	/** Reports a misspelling at a position in the block. */
	private alert(word: string, at: number, length: number): Alert {
		const a: Alert = {
			action: {
				name: this.definition.action.name,
				params: [...this.definition.action.params],
			},
			suggestions: [],
			check: this.definition.name,
			severity: this.definition.level,
			span: [at, at + length],
			link: this.definition.link,
			match: word,
			description: "",
			message: "",
			line: 0,
		};
		[a.message, a.description] = formatMessages(
			this.definition.message,
			this.definition.description,
			word,
		);
		return a;
	}

	/**
	 * Rewrites a misspelling alert when more is known about the word, with a
	 * fix that is certain: the dictionary spells it in another case, or it is
	 * shaped like an identifier in a format with inline code.
	 */
	private explain(a: Alert, word: string, found: string, f: File | null): void {
		const cased = this.gs.recase(word);
		if (cased !== null && certainRecase(word, cased)) {
			a.message = `Use '${cased}' instead of '${found}'.`;
			a.action = { name: "replace", params: [cased] };
			a.suggestions = a.action.params;
			return;
		}

		if (this.split || f === null || !IDENTIFIER_SHAPE.test(found)) return;
		const wrap = INLINE_CODE[f.normedExt];
		if (wrap !== undefined) {
			const code = wrap.replace("%s", found);
			a.message = `'${found}' looks like code; format it as code.`;
			a.action = { name: "replace", params: [code] };
			a.suggestions = a.action.params;
		}
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return "";
	}

	/** The closest spellings of `word` from the dictionaries. */
	suggest(word: string): string[] {
		return this.suggestFor(word, null);
	}

	/**
	 * `suggest` with the project's vocabularies as candidates too: an accepted
	 * term as close as a dictionary word is suggested first, in the case the
	 * vocabulary spells it.
	 */
	suggestFor(word: string, cfg: Config | null): string[] {
		const ranked = this.gs.rank(word);
		if (cfg === null) return ranked.map((r) => r.word);

		const lower = word.toLowerCase();
		const floor = ranked.length > 0 ? ranked[ranked.length - 1]!.score : 0;

		const terms = [...cfg.acceptedTokens];
		for (const v of Object.values(cfg.vocabularies)) {
			terms.push(...v.accepted);
		}

		const merged: Suggestion[] = [];
		for (const term of terms) {
			if (term.toLowerCase() === lower) continue;
			const score = similarity(term.toLowerCase(), lower);
			if (score >= floor && score > 0) merged.push({ word: term, score });
		}

		// Stable, so a vocabulary term keeps its place ahead of a dictionary
		// word it ties with, or repeats.
		merged.push(...ranked);
		merged.sort((a, b) => b.score - a.score);

		const out: string[] = [];
		const seen = new Set<string>();
		for (const m of merged) {
			if (seen.has(m.word)) continue;
			seen.add(m.word);
			out.push(m.word);
			if (out.length === 6) break;
		}
		return out;
	}

	/** Builds the checker this rule reads, from the dictionaries it names. */
	private makeSpeller(cfg: Config | null, rulePath: string): Checker {
		const stylesPath = cfg?.stylesPath() ?? "";

		const affloc = cfg === null ? "" : findAsset(cfg, this.aff);
		const dicloc = cfg === null ? "" : findAsset(cfg, this.dic);

		if (fileExists(affloc) && fileExists(dicloc)) {
			return newChecker(usingDictionaryByPath(dicloc, affloc));
		}

		const options = [withDefault(this.append)];
		if (this.dicpath !== "") {
			// An absolute path as `$DICPATH` would hold, a path relative to
			// the styles path, or one relative to the working directory.
			const paths = [
				this.dicpath,
				joinPath(stylesPath, this.dicpath),
				resolve(this.dicpath),
			];
			const found = paths.find((p) => isDir(p));
			if (found === undefined) throw new Error("unable to resolve dicpath");
			options.push(withPath(found));
		} else {
			options.push(withPath(joinPath(stylesPath, DICT_DIR)));
		}

		if (this.dictionaries.length > 0) {
			for (const name of this.dictionaries) options.push(usingDictionary(name));
			return newChecker(...options);
		}

		if (rulePath === "internal") {
			// With neither a `dicpath` nor named dictionaries, the built-in one
			// is what a rule gets.
			options.push(withDefaultPath(joinPath(stylesPath, DICT_DIR)));
		}

		return newChecker(...options);
	}
}

/**
 * Whether the dictionary's other-case spelling is a fix to offer: one that
 * adds capitals inside a word of three or more letters with at most one, as in
 * GitHub or JSON.
 *
 * A capitalized-only name (Kubernetes) cannot be told from a word in another
 * language (los, Los), and a word with more capitals (CNs) chose them.
 */
export function certainRecase(word: string, cased: string): boolean {
	const upper = (s: string): number => {
		let n = 0;
		for (const r of s) {
			if (/\p{Lu}/u.test(r)) n++;
		}
		return n;
	};
	const inner = [...cased].slice(1).some((r) => /\p{Lu}/u.test(r));
	return (
		[...word].length >= 3 && upper(word) <= 1 && upper(cased) > upper(word) && inner
	);
}

export type { IdentifierPart };
