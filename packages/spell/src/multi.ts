/**
 * A spell checker over several Hunspell-compatible dictionaries.
 *
 * A word is correct when any one of them accepts it, and a suggestion is the
 * best any of them offers. Every checker that names the same files shares one
 * loaded copy of the dictionary, since loading a large one is the expensive
 * part and nothing about it changes afterwards; what a checker adds -- its
 * ignore-list words and its lookup caches -- is its own, which is what
 * `fork` separates.
 */

import { readdirSync, readlinkSync, statSync } from "node:fs";
import * as nodePath from "node:path";

import { builtinAffix, builtinDictionary, builtinName } from "./builtin.ts";
import type { GoSpell, WordMatch } from "./gospell.ts";
import { newGoSpell, GoSpell as Speller } from "./gospell.ts";
import { similarity } from "./similarity.ts";

/** A dictionary named by the paths of its two files. */
export interface DictionaryPaths {
	dic: string;
	aff: string;
}

/** A dictionary given as the text of its two files. */
export interface DictionaryText {
	/** A name for the pair, which is also its cache key. */
	name: string;
	aff: string;
	dic: string;
}

/** Controls the checker-creation process. */
export interface Options {
	path: string;
	defaultPath: string;
	system: string;
	names: string[];
	dics: DictionaryPaths[];
	texts: DictionaryText[];
	load: boolean;
}

/** A setting that changes the checker-creation process. */
export type CheckerOption = (opts: Options) => void;

function defaultOptions(): Options {
	const dicpath = process.env.DICPATH ?? "";
	return {
		path: dicpath,
		defaultPath: "",
		system: dicpath,
		names: [],
		dics: [],
		texts: [],
		load: false,
	};
}

/** Specifies the location of Hunspell-compatible dictionaries. */
export function withPath(path: string): CheckerOption {
	return (opts) => {
		opts.path = path;
	};
}

/** Specifies whether Vale's default dictionary should be loaded. */
export function withDefault(load: boolean): CheckerOption {
	return (opts) => {
		opts.load = load;
	};
}

/** Specifies a path from which all dictionaries should be loaded. */
export function withDefaultPath(path: string): CheckerOption {
	return (opts) => {
		opts.defaultPath = path;
	};
}

/** Loads the named Hunspell-compatible dictionary. */
export function usingDictionary(name: string): CheckerOption {
	return (opts) => {
		opts.names.push(name);
	};
}

/** Loads the given Hunspell-compatible dictionary from local paths. */
export function usingDictionaryByPath(dic: string, aff: string): CheckerOption {
	return (opts) => {
		opts.dics.push({ dic, aff });
	};
}

/**
 * Loads a dictionary from the text of its two files, for a caller that holds
 * them already and should not have to write them out.
 */
export function usingDictionaryText(
	name: string,
	aff: string,
	dic: string,
): CheckerOption {
	return (opts) => {
		opts.texts.push({ name, aff, dic });
	};
}

/** A candidate spelling and how close it is to the word. */
export interface Suggestion {
	word: string;
	score: number;
}

/**
 * Each loaded dictionary by its source, so that every spelling rule naming
 * the same files shares one copy.
 */
const dictionaries = new Map<string, GoSpell>();

/** A checker over the dictionary `key` names, loading it once. */
function sharedDictionary(key: string, load: () => GoSpell): GoSpell {
	const pristine = dictionaries.get(key);
	if (pristine !== undefined) return pristine.fork();
	const loaded = load();
	dictionaries.set(key, loaded);
	return loaded.fork();
}

/** Forgets every shared dictionary, so a later checker loads afresh. */
export function clearDictionaryCache(): void {
	dictionaries.clear();
}

/** A spell checker based on multiple dictionaries. */
export class Checker {
	private readonly options: Options;
	private readonly checkers: GoSpell[] = [];
	/** Each word's other-case spelling, or null when it has none. */
	private readonly recased = new Map<string, string | null>();

	constructor(options: Partial<Options> = {}) {
		this.options = { ...defaultOptions(), ...options };
	}

	/**
	 * The `.aff` directives the loaded dictionaries use that the checker does
	 * not implement, sorted.
	 */
	ignored(): string[] {
		const names: string[] = [];
		for (const checker of this.checkers) {
			for (const name of checker.ignored) {
				if (!names.includes(name)) names.push(name);
			}
		}
		names.sort();
		return names;
	}

	/** Reports whether a given word is in the dictionaries. */
	spell(word: string): boolean {
		for (const checker of this.checkers) {
			if (checker.spell(word)) return true;
		}
		return false;
	}

	/**
	 * The spelling a dictionary has for `word` in another case, when there is
	 * exactly one: GitHub for github.
	 */
	recase(word: string): string | null {
		const known = this.recased.get(word);
		if (known !== undefined) return known;
		let cased: string | null = null;
		for (const checker of this.checkers) {
			const c = checker.recase(word);
			if (c !== null) {
				cased = c;
				break;
			}
		}
		this.recased.set(word, cased);
		return cased;
	}

	/** A list of suggestions for a given word. */
	suggest(word: string): string[] {
		return this.rank(word).map((r) => r.word);
	}

	/**
	 * The closest spellings of `word` across the dictionaries, best first, at
	 * most six.
	 */
	rank(word: string): Suggestion[] {
		const ranks: WordMatch[] = [];
		for (const checker of this.checkers) {
			ranks.push(...checker.rank(word));
		}
		ranks.sort((a, b) => b.score - a.score);
		return ranks.slice(0, 6).map((r) => ({ word: r.word, score: r.score }));
	}

	/** The underlying dictionary's root words, for the given index. */
	dict(i: number): Set<string> {
		const checker = this.checkers[i];
		if (checker === undefined) throw new Error(`no dictionary at index ${i}`);
		return new Set(checker.keys());
	}

	/** Performs character substitutions (ICONV). */
	convert(s: string): string {
		let out = s;
		for (const checker of this.checkers) out = checker.inputConversion(out);
		return out;
	}

	/** Reads in a word-list file. */
	addWordListFile(name: string): void {
		for (const checker of this.checkers) checker.addWordListFile(name);
	}

	/** `addWordListFile` over a list a caller holds as text. */
	addWordList(contents: string): void {
		for (const checker of this.checkers) checker.addWordList(contents);
	}

	/** Adds one word to every dictionary's ignore list, as written. */
	addWordRaw(word: string): void {
		for (const checker of this.checkers) checker.addWordRaw(word);
	}

	/** How many dictionaries the checker holds. */
	get size(): number {
		return this.checkers.length;
	}

	/** @internal -- `newChecker` fills the checker through this. */
	push(checker: GoSpell): void {
		this.checkers.push(checker);
	}

	/**
	 * Finds a dictionary asset by name, as a spelling rule's dictionaries are
	 * found: in each search path, then in $DICPATH.
	 */
	readAsset(name: string): string {
		const roots = [
			this.options.defaultPath,
			this.options.path,
			this.options.system,
		];

		for (const p of roots) {
			if (p === "") continue;

			const option = join(p, name);
			if (fileExists(option)) return option;

			// The asset may be a symlink (a Nix store path exposed through
			// $DICPATH, say). A failed readlink just means this root does not
			// have it, so keep trying the remaining roots instead of bailing
			// out -- returning the error here once made Vale ignore $DICPATH.
			const link = readLink(option);
			if (link !== null && fileExists(link)) return link;
		}

		throw new Error(`'${name}' not found in ${JSON.stringify(roots)}`);
	}

	/** Loads the named dictionary from the search paths. */
	loadDic(name: string): void {
		const dicPath = this.readAsset(`${name}.dic`);
		const affPath = this.readAsset(`${name}.aff`);
		this.push(
			sharedDictionary(`${affPath}\u0000${dicPath}`, () =>
				newGoSpell(affPath, dicPath),
			),
		);
	}
}

/**
 * Creates a spell checker from multiple Hunspell-compatible dictionaries.
 *
 * With no dictionary named, or with `withDefault(true)`, the built-in
 * `en_US-web` dictionary is loaded as well.
 */
export function newChecker(...options: CheckerOption[]): Checker {
	const base = defaultOptions();
	for (const applyOpt of options) applyOpt(base);

	const checker = new Checker(base);
	for (const name of base.names) checker.loadDic(name);

	for (const entry of base.dics) {
		checker.push(
			sharedDictionary(`${entry.aff}\u0000${entry.dic}`, () =>
				newGoSpell(entry.aff, entry.dic),
			),
		);
	}

	for (const entry of base.texts) {
		checker.push(
			sharedDictionary(`text\u0000${entry.name}`, () =>
				Speller.load(entry.aff, entry.dic),
			),
		);
	}

	if (checker.size === 0 || base.load) {
		// use default dictionary ...
		checker.push(
			sharedDictionary(`embedded\u0000${builtinName}`, () =>
				Speller.load(builtinAffix(), builtinDictionary()),
			),
		);
	}

	if (base.defaultPath !== "") {
		// load all dictionaries from the given path ...
		for (const f of dicFilesIn(base.defaultPath)) {
			checker.loadDic(f.slice(0, -".dic".length));
		}
	}

	return checker;
}

/** The closeness of two spellings, from 0 to 1, as the suggester measures it. */
export { similarity };

/**
 * `filepath.Join(dir, name)`: the platform's own separator.
 *
 * A hard-coded `/` here reads a file on Windows and then reports a path with
 * both separators in it, which a caller comparing paths does not recognize.
 */
function join(dir: string, name: string): string {
	if (dir === "") return name;
	return nodePath.join(dir, name);
}

/** `os.Stat(path) == nil`: the path resolves to something that exists. */
function fileExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function readLink(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

/** The `.dic` file names directly in `dir`, sorted as a glob reports them. */
function dicFilesIn(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// A path with nothing in it loads nothing, as a glob that matches
		// nothing does.
		return [];
	}
	return names.filter((n) => n.endsWith(".dic")).sort();
}
