/**
 * The dictionary: reading a `.dic`, deciding whether a word is spelled
 * correctly, and suggesting what was meant instead.
 *
 * A lookup is not a set membership test. Hunspell decides from the capitals a
 * word is written with which other spellings it may stand for, from its affix
 * flags which forms an entry generates, and from its compound directives
 * whether a word the dictionary never lists is still built from words it
 * does. All of that happens on lookup, against the entries as the `.dic`
 * wrote them; see `lazy.ts` for why.
 */

import { readFileSync } from "node:fs";

import type { CompoundPattern, DictConfig, EntryForm, Segment } from "./aff.ts";
import {
	emptySegment,
	hasFlag,
	isMorphField,
	mergeSegments,
	newDictConfig,
} from "./aff.ts";
import { decodeDictionary, decodeDictionaryText } from "./encoding.ts";
import type { Analyzer, RootEntry } from "./lazy.ts";
import { readings } from "./lazy.ts";
import { similarity } from "./similarity.ts";
import {
	capitalize,
	fields,
	firstRune,
	isLetter,
	isUpper,
	lines,
	lowerFirst,
	quoteMeta,
	Replacer,
	runes,
	toLower,
	toUpper,
	trimSpace,
} from "./text.ts";
import {
	isHash,
	isNumber,
	isNumberBinary,
	isNumberHex,
	isNumberUnits,
	Splitter,
} from "./words.ts";

/** One suggestion and how close it is to the word. */
export interface WordMatch {
	word: string;
	score: number;
	/** From an ignore list rather than the dictionary. */
	listed: boolean;
}

/** One Hunspell BREAK pattern: a literal a word may be split on. */
interface BreakRule {
	pattern: string;
	/** Written `^pattern`: the pattern is stripped from the start. */
	atStart: boolean;
	/** Written `pattern$`: the pattern is stripped from the end. */
	atEnd: boolean;
}

/** How many times a word may be split by BREAK rules. */
const maxBreakDepth = 10;

/** What Hunspell uses when a dictionary declares no BREAK. */
const defaultBreaks = ["-", "^-", "-$"];

/** Bounds the lookup caches. */
const cacheMax = 1 << 16;

/**
 * How many of the closest roots are expanded for suggestions, and how many
 * forms are considered in total.
 */
const suggestRoots = 20;
const suggestForms = 20000;

function newBreakRules(patterns: readonly string[]): BreakRule[] {
	const rules: BreakRule[] = [];
	for (const p of patterns) {
		const r: BreakRule = { pattern: p, atStart: false, atEnd: false };
		if (r.pattern.length > 1 && r.pattern.startsWith("^")) {
			r.atStart = true;
			r.pattern = r.pattern.slice(1);
		}
		if (r.pattern.length > 1 && r.pattern.endsWith("$")) {
			r.atEnd = true;
			r.pattern = r.pattern.slice(0, -1);
		}
		if (r.pattern !== "") rules.push(r);
	}
	return rules;
}

/** A cached segment lookup. */
interface SegmentUse {
	seg: Segment;
	ok: boolean;
}

/**
 * What a `.aff` and `.dic` pair loads to. It is never written after loading,
 * so checkers share it.
 */
interface DictData {
	affix: DictConfig;

	/**
	 * The `.dic` entries by word, one per homonym line. Their forms are
	 * generated on lookup rather than at load, which is what keeps an
	 * inflected language's dictionary in memory.
	 */
	roots: Map<string, RootEntry[]>;
	/**
	 * The upper-cased form of each root with a capital, mapped to the roots it
	 * stands for -- Hunspell's hidden upper-case homonym.
	 */
	upperRoots: Map<string, string[]>;
	/**
	 * The FORBIDDENWORD entries; their forms are not words, and no other
	 * reading of one may accept it.
	 */
	forbiddenRoots: Map<string, RootEntry[]>;
	/**
	 * The run-together form of each two-word entry, which is not a compound.
	 */
	pairs: Set<string>;

	ireplacer: Replacer | null;
	compounds: RegExp[];
	splitter: Splitter;
	/** The dictionary uses COMPOUNDFLAG/BEGIN/MIDDLE/END. */
	canCompound: boolean;
	compoundMin: number;
	checkDup: boolean;
	checkTriple: boolean;
	simplified: boolean;
	checkCase: boolean;
	checkRep: boolean;
	/** COMPOUNDWORDMAX, or 0. */
	wordMax: number;
	/** COMPOUNDSYLLABLE, or 0. */
	syllableMax: number;
	vowels: string;
	reps: ReadonlyArray<readonly [string, string]>;
	patterns: CompoundPattern[];
	breaks: BreakRule[];
	/** The `.aff` directives the reader does not implement. */
	ignored: string[];
}

/** A segment of a compound as written, with what it may do and the compound
 * so far, up to and including it. */
interface Piece {
	text: string;
	use: Segment;
	sofar: string;
}

/** Reports whether `word` has letters and every one is upper-case. */
export function allUpper(word: string): boolean {
	let letters = false;
	for (const r of word) {
		if (!isLetter(r)) continue;
		if (!isUpper(r)) return false;
		letters = true;
	}
	return letters;
}

/** Reports whether `word` starts with an upper-case letter. */
export function initialUpper(word: string): boolean {
	const first = firstRune(word);
	return first !== "" && isUpper(first);
}

/** Hunspell's classification of a word by its capitals. */
export type CaseStyle =
	/** hello */
	| "noCap"
	/** Hello */
	| "initCap"
	/** HELLO */
	| "allCap"
	/** ULinda */
	| "huhInitCap"
	/** uLinda, fOO */
	| "huhCap";

/** Reports which case forms a word may stand for. */
export function classifyCase(word: string): CaseStyle {
	let letters = 0;
	let uppers = 0;
	let firstUpper = false;
	let at = 0;
	for (const r of word) {
		if (isLetter(r)) {
			letters++;
			if (isUpper(r)) {
				uppers++;
				if (at === 0) firstUpper = true;
			}
		}
		at += r.length;
	}
	if (uppers === 0) return "noCap";
	if (uppers === letters) return "allCap";
	if (uppers === 1 && firstUpper) return "initCap";
	if (firstUpper) return "huhInitCap";
	return "huhCap";
}

/**
 * Divides a `.dic` entry into its word and flags.
 *
 * A `\/` is a slash in the word, and so is a slash that starts it.
 */
export function splitEntry(entry: string): [string, string, boolean] {
	const escaped = "￿";
	const s = entry.replaceAll("\\/", escaped);
	const at = s.indexOf("/", 1);
	if (at < 0) return [s.replaceAll(escaped, "/"), "", false];
	return [s.slice(0, at).replaceAll(escaped, "/"), s.slice(at + 1), true];
}

/**
 * Checks words against one dictionary.
 *
 * The dictionary is shared by every checker that loads the same files; the
 * ignore-list words and the lookup caches are a checker's own.
 */
export class GoSpell implements Analyzer {
	private readonly data: DictData;

	/**
	 * The words an ignore list added. They match as written or lower-cased,
	 * whatever the input's case, as they always have.
	 */
	private listed = new Set<string>();

	/**
	 * Lookups are memoized, since a document repeats its words and a checker
	 * is shared by the files linted together.
	 */
	private spelled = new Map<string, boolean>();
	private segments = new Map<string, SegmentUse>();

	constructor(data: DictData) {
		this.data = data;
	}

	get affix(): DictConfig {
		return this.data.affix;
	}

	get upperRoots(): Map<string, string[]> {
		return this.data.upperRoots;
	}

	/** The `.aff` directives the dictionary used that this reader ignores. */
	get ignored(): readonly string[] {
		return this.data.ignored;
	}

	/** The word-splitter built from the dictionary's WORDCHARS. */
	get splitter(): Splitter {
		return this.data.splitter;
	}

	/**
	 * A checker over the same dictionary with its own ignore list and caches.
	 */
	fork(): GoSpell {
		return new GoSpell(this.data);
	}

	/** The root words of the dictionary, as the `.dic` wrote them. */
	keys(): string[] {
		return Array.from(this.data.roots.keys());
	}

	/** The character substitutions ICONV asks for, applied before checking. */
	inputConversion(raw: string): string {
		const r = this.data.ireplacer;
		return r === null ? raw : r.replace(raw);
	}

	/**
	 * Adds a single word to the ignore list without modification, returning
	 * false when it was already there.
	 */
	addWordRaw(word: string): boolean {
		if (this.listed.has(word)) return false;
		this.listed.add(word);
		this.spelled = new Map();
		return true;
	}

	/**
	 * Adds a word list, one word per line, returning the words that were
	 * already known.
	 *
	 * Hunspell's `*` prefix for a forbidden word, and affix support, are not
	 * handled here yet.
	 */
	addWordList(contents: string): string[] {
		const duplicates: string[] = [];
		for (const line of lines(contents)) {
			const word = trimSpace(line);
			if (word.length === 0 || word === "#") continue;
			if (!this.addWordRaw(word)) duplicates.push(word);
		}
		return duplicates;
	}

	/** `addWordList` over a file, which is assumed to be UTF-8. */
	addWordListFile(name: string): string[] {
		return this.addWordList(readTextFile(name));
	}

	/** Reports whether a given word is in the dictionaries. */
	spell(word: string): boolean {
		const known = this.spelled.get(word);
		if (known !== undefined) return known;

		// The input is read as the dictionary is: through ICONV, and without
		// the IGNORE characters.
		const ok = this.spellDepth(this.affix.ignore(this.inputConversion(word)), 0);

		if (this.spelled.size > cacheMax) this.spelled = new Map();
		this.spelled.set(word, ok);
		return ok;
	}

	/** The closest spellings of `word`, best first, at most five. */
	suggest(word: string): string[] {
		return this.rank(word).map((m) => m.word);
	}

	/** `suggest` with each candidate's score; see `Checker.rank`. */
	rank(word: string): WordMatch[] {
		const hits: WordMatch[] = [];
		const seen = new Set<string>([word]);
		const add = (w: string): void => {
			if (seen.has(w)) return;
			seen.add(w);
			// Earlier is better; the score keeps that order across checkers.
			hits.push({ word: w, score: 1 - hits.length / 1e6, listed: false });
		};

		// The word in another case, then the dictionary's own spelling of it,
		// then what the REP table and a split make of it: Hunspell's order.
		const lower = this.lowerWord(word);
		for (const v of [lower, capitalize(lower), this.upperKey(word)]) {
			if (v !== word && this.spellDepth(v, 0)) add(v);
		}
		const cased = this.analyses(this.upperKey(word), true).concat(
			this.analyses(lower, false),
		);
		for (const f of cased) {
			if (
				toLower(f.word) === toLower(word) &&
				!hasFlag(f.flags, this.affix.compoundOnly)
			) {
				add(f.word);
			}
		}
		for (const rep of this.data.reps) {
			const from = rep[0];
			const to = rep[1].replaceAll("_", " ");
			for (let at = word.indexOf(from); at >= 0; ) {
				const candidate = word.slice(0, at) + to + word.slice(at + from.length);
				if (this.spellPhrase(candidate)) add(candidate);
				const next = word.slice(at + 1).indexOf(from);
				if (next < 0) break;
				at += 1 + next;
			}
		}
		for (let i = 1; i < word.length; i++) {
			const left = word.slice(0, i);
			const right = word.slice(i);
			if (this.spellDepth(left, 0) && this.spellDepth(right, 0)) {
				add(`${left} ${right}`);
			}
		}
		if (hits.length >= 5) return hits.slice(0, 5);

		// Then the closest words. Roots are ranked first, and the forms of the
		// closest ones after, so an inflected form is still found without
		// generating every form. Distance is measured case-insensitively; the
		// case comes back below.
		let roots: WordMatch[] = [];
		for (const option of this.keys()) {
			roots.push({
				word: option,
				score: similarity(option, lower),
				listed: false,
			});
		}

		// A word from an ignore list is the project's own, and comes first
		// among candidates it ties with.
		const listed: WordMatch[] = [];
		for (const option of this.listed) {
			listed.push({
				word: option,
				score: similarity(this.lowerWord(option), lower),
				listed: true,
			});
		}
		roots.sort((i, j) => {
			if (i.score !== j.score) return j.score - i.score;
			// A tie is broken the same way every run.
			return i.word < j.word ? -1 : i.word > j.word ? 1 : 0;
		});
		if (roots.length > suggestRoots) roots = roots.slice(0, suggestRoots);

		const formSeen = new Set<string>();
		const matches: WordMatch[] = [];
		const e = this.affix.expander(null, null);
		for (const r of roots) {
			for (const entry of this.data.roots.get(r.word) ?? []) {
				for (const f of e.root(r.word, entry.flags)) {
					if (formSeen.has(f.word) || formSeen.size > suggestForms) continue;
					formSeen.add(f.word);
					matches.push({
						word: f.word,
						score: similarity(f.word, lower),
						listed: false,
					});
				}
			}
		}
		matches.push(...listed);
		matches.sort((i, j) => {
			if (i.score !== j.score) return j.score - i.score;
			if (i.listed !== j.listed) return i.listed ? -1 : 1;
			return i.word < j.word ? -1 : i.word > j.word ? 1 : 0;
		});

		// Suggestions take the case the word was written in.
		let restore = (w: string): string => w;
		if (allUpper(word)) restore = (w) => this.upperKey(w);
		else if (initialUpper(word)) restore = capitalize;

		for (const m of matches) {
			if (hits.length >= 5) break;
			const w = restore(m.word);
			if (seen.has(w)) continue;
			seen.add(w);
			hits.push({ word: w, score: m.score, listed: m.listed });
		}
		return hits;
	}

	/**
	 * The one spelling the dictionary has for `word` in another case, such as
	 * GitHub for github. Two spellings that differ in case, or none, give null.
	 */
	recase(word: string): string | null {
		let found = "";
		for (const f of this.analyses(this.upperKey(word), true)) {
			if (f.word === word || this.isForbidden(f.word) || !this.spell(f.word)) {
				continue;
			}
			if (found !== "" && found !== f.word) return null;
			found = f.word;
		}
		return found !== "" ? found : null;
	}

	/**
	 * Every reading of `word` as a root plus affixes, with the flags each
	 * reading carries.
	 */
	analyses(word: string, fold: boolean): EntryForm[] {
		return readings(this, word, fold, this.data.roots);
	}

	/**
	 * Upper-cases a word as an all-caps writer would: under CHECKSHARPS, ß
	 * and ẞ become SS; in a Turkic language, i becomes İ and ı becomes I.
	 */
	upperKey(word: string): string {
		let w = word;
		if (this.turkic()) w = TURKIC_UPPER.replace(w);
		const upper = toUpper(w);
		return this.affix.checkSharps ? SHARP_UPPER.replace(upper) : upper;
	}

	/**
	 * Lower-cases a word: in a Turkic language, İ becomes i and I becomes ı.
	 */
	lowerWord(word: string): string {
		return toLower(this.turkic() ? TURKIC_LOWER.replace(word) : word);
	}

	/** Reports whether LANG names a language with the dotted and dotless i. */
	private turkic(): boolean {
		const lang = this.affix.lang.toLowerCase();
		return lang.startsWith("tr") || lang.startsWith("az") || lang.startsWith("crh");
	}

	/**
	 * Reports whether `word` starts with İ outside a Turkic language, where
	 * that letter has no lower-case form to fold to.
	 */
	private dottedFirst(word: string): boolean {
		return !this.turkic() && word.startsWith("İ");
	}

	/** Reports whether `word` holds a sharp s, in either case. */
	private hasSharp(word: string): boolean {
		return this.affix.checkSharps && (word.includes("ß") || word.includes("ẞ"));
	}

	/**
	 * Reports whether a FORBIDDENWORD entry generates `word`.
	 *
	 * Hunspell reads homonyms in order and the first decides, so a word that
	 * is itself a root of another entry stays valid.
	 */
	private isForbidden(word: string): boolean {
		if (this.data.forbiddenRoots.size === 0) return false;
		if (this.data.roots.has(word)) return false;
		return readings(this, word, false, this.data.forbiddenRoots).length > 0;
	}

	/**
	 * Reports whether `word` is a form some entry generates and may stand on
	 * its own. A folded word, one whose case was changed to look it up, is not
	 * a KEEPCASE form.
	 */
	private isWord(word: string, folded: boolean): boolean {
		if (this.isForbidden(word)) return false;
		for (const f of this.analyses(word, false)) {
			if (hasFlag(f.flags, this.affix.compoundOnly)) continue;
			// Under CHECKSHARPS, KEEPCASE on a word with ß only says its
			// all-caps form is written with SS; it may still be capitalized.
			if (
				folded &&
				hasFlag(f.flags, this.affix.keepCaseFlag) &&
				!this.hasSharp(f.word)
			) {
				continue;
			}
			return true;
		}
		return false;
	}

	/**
	 * Reports whether an all-caps word is the upper-cased form of one some
	 * entry generates. Under CHECKSHARPS, a KEEPCASE word with ß may be
	 * upper-cased, but only written with SS.
	 */
	private isWordUpper(word: string): boolean {
		for (const f of this.analyses(this.upperKey(word), true)) {
			if (this.isForbidden(f.word)) continue;
			if (hasFlag(f.flags, this.affix.compoundOnly)) continue;
			if (
				hasFlag(f.flags, this.affix.keepCaseFlag) &&
				!(this.hasSharp(f.word) && !this.hasSharp(word))
			) {
				continue;
			}
			return true;
		}
		return false;
	}

	/**
	 * Reports whether every space-separated part of a phrase is a word, for a
	 * REP entry that writes one word as two.
	 */
	private spellPhrase(phrase: string): boolean {
		for (const part of fields(phrase)) {
			if (!this.spellDepth(part, 0)) return false;
		}
		return true;
	}

	/** `spell` with a count of how many BREAK splits led here. */
	private spellDepth(word: string, depth: number): boolean {
		if (this.isForbidden(word)) return false;
		// A trailing period is an abbreviation's, or the sentence's.
		if (word.endsWith(".")) {
			const t = word.replace(/\.+$/, "");
			if (t !== "" && this.spellDepth(t, depth)) return true;
		}
		if (this.listed.has(word)) return true;
		if (this.isWord(word, false)) return true;

		// The forms a word may stand for, as Hunspell reads its capitals.
		const lower = this.lowerWord(word);
		if (this.listed.has(lower)) return true;
		switch (classifyCase(word)) {
			case "noCap":
			case "huhCap":
				// As written only: fOO is not foo.
				break;
			case "initCap":
				if (!this.dottedFirst(word) && this.isWord(lower, true)) return true;
				break;
			case "allCap": {
				if (this.isWordUpper(word)) return true;
				// A KEEPCASE word is not reached by folding an all-caps one, and
				// under CHECKSHARPS an all-caps ß word is written with SS.
				let forms = [lower, capitalize(lower)];
				if (this.dottedFirst(word)) {
					// İZMİR is İzmir: the first letter keeps its dot.
					forms = [`İ${this.lowerWord(word.slice("İ".length))}`];
				}
				for (const form of forms) {
					for (const f of this.analyses(form, false)) {
						if (
							this.isForbidden(f.word) ||
							hasFlag(f.flags, this.affix.compoundOnly) ||
							hasFlag(f.flags, this.affix.keepCaseFlag) ||
							this.hasSharp(f.word)
						) {
							continue;
						}
						return true;
					}
				}
				break;
			}
			case "huhInitCap": {
				const n = firstRune(word).length;
				if (
					!this.dottedFirst(word) &&
					this.isWord(this.lowerWord(word.slice(0, n)) + word.slice(n), true)
				) {
					return true;
				}
				break;
			}
		}

		if (isNumber(word)) return true;
		if (isNumberHex(word)) return true;
		if (isNumberBinary(word)) return true;
		if (isHash(word)) return true;

		// A COMPOUNDRULE reads the word as written or, for a capitalized or
		// all-caps word, lower-cased: 42ND is 42nd. A compound has two parts at
		// least, so an entry on its own is not one.
		for (const pat of this.data.compounds) {
			if (!this.data.roots.has(word) && pat.test(word)) return true;
			if (
				!this.data.roots.has(lower) &&
				lower !== word &&
				classifyCase(word) !== "huhCap" &&
				pat.test(lower)
			) {
				return true;
			}
		}

		// Affix-flag compounding (German, Dutch, ...): accept a word that
		// splits into dictionary segments.
		if (this.isCompound(word)) return true;

		// Maybe a word with units? e.g. 100GB
		const units = isNumberUnits(word);
		if (units !== "" && this.isWord(units, false)) return true;

		return this.breakParts(word, depth);
	}

	/**
	 * Reports whether `word` is valid once split by the dictionary's BREAK
	 * rules: an anchored rule strips its pattern from that end, and any other
	 * rule splits at each occurrence, with both sides then checked on their
	 * own (and split again as needed).
	 */
	private breakParts(word: string, depth: number): boolean {
		if (depth >= maxBreakDepth) return false;
		for (const r of this.data.breaks) {
			const n = r.pattern.length;
			if (r.atStart) {
				if (
					word.length > n &&
					word.startsWith(r.pattern) &&
					this.spellDepth(word.slice(n), depth + 1)
				) {
					return true;
				}
			} else if (r.atEnd) {
				if (
					word.length > n &&
					word.endsWith(r.pattern) &&
					this.spellDepth(word.slice(0, word.length - n), depth + 1)
				) {
					return true;
				}
			} else {
				// Only interior occurrences: both sides must be non-empty.
				for (let i = word.slice(1).indexOf(r.pattern); i >= 0; ) {
					const at = i + 1;
					if (at + n >= word.length) break;
					if (
						this.spellDepth(word.slice(0, at), depth + 1) &&
						this.spellDepth(word.slice(at + n), depth + 1)
					) {
						return true;
					}
					const next = word.slice(at + 1).indexOf(r.pattern);
					if (next < 0) break;
					i = at + next;
				}
			}
		}
		return false;
	}

	/**
	 * What a compound may use `word` as.
	 *
	 * The case is the dictionary's to handle: a German dictionary generates
	 * the lower-case interior forms itself, with prefix rules that strip the
	 * capital.
	 */
	private segment(word: string): SegmentUse {
		const cached = this.segments.get(word);
		if (cached !== undefined) return cached;

		let merged = emptySegment();
		let found = false;
		if (!this.isForbidden(word)) {
			for (const f of this.analyses(word, false)) {
				if (
					f.prefix === null &&
					f.suffix === null &&
					hasFlag(f.flags, this.affix.compoundForbidFlag)
				) {
					// The entry itself is kept out, whatever its other forms allow.
					found = false;
					break;
				}
				let seg = this.affix.compoundUse(f);
				if (seg === null) continue;
				seg.keep = hasFlag(f.flags, this.affix.keepCaseFlag);
				if (found) seg = mergeSegments(merged, seg);
				merged = seg;
				found = true;
			}
		}
		const use: SegmentUse = { seg: merged, ok: found };
		if (this.segments.size > cacheMax) this.segments = new Map();
		this.segments.set(word, use);
		return use;
	}

	/**
	 * Reports whether `word` is built from segments the dictionary's compound
	 * flags allow, for dictionaries that enable flag compounding. The word is
	 * tried as written and, as Hunspell does, in the case forms a capitalized
	 * or upper-cased word may stand for.
	 */
	private isCompound(word: string): boolean {
		if (!this.data.canCompound) return false;
		if (this.data.pairs.has(word)) return false;
		// Bound the work: very long inputs are unlikely to be real words and
		// the recursion is super-linear.
		const chars = runes(word);
		if (chars.length > 100) return false;

		if (this.compoundParts(chars, word, false, null, null, 0)) return true;

		// A folded form: a KEEPCASE segment refuses it.
		let forms: string[] = [];
		const lower = toLower(word);
		switch (classifyCase(word)) {
			case "noCap":
			case "huhCap":
				// As written only.
				break;
			case "allCap":
				forms = [lower, capitalize(lower)];
				break;
			case "initCap":
				forms = [lower];
				break;
			case "huhInitCap":
				forms = [lowerFirst(word)];
				break;
		}
		for (const form of forms) {
			if (this.compoundParts(runes(form), word, true, null, null, 0)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Reports whether `chars` split into segments allowed at their positions.
	 *
	 * `prev` is the segment before them; `need` is the pattern whose
	 * replacement they follow, if any; `word` is the whole word, for
	 * FORCEUCASE, and `folded` says `chars` is a case-folded form of it.
	 */
	private compoundParts(
		chars: string[],
		word: string,
		folded: boolean,
		prev: Piece | null,
		need: CompoundPattern | null,
		depth: number,
	): boolean {
		if (depth > 4) return false; // cap the number of segments
		// Past COMPOUNDWORDMAX segments, only a short compound goes on:
		// Hungarian allows three parts in six syllables.
		if (
			this.data.wordMax > 0 &&
			depth + 2 > this.data.wordMax &&
			(this.data.syllableMax === 0 || this.syllables(word) > this.data.syllableMax)
		) {
			return false;
		}
		const minLen = Math.max(this.data.compoundMin, 1);
		const n = chars.length;

		for (let i = minLen; i <= n - minLen; i++) {
			if (!this.boundaryOK(chars, i)) continue;
			const left = chars.slice(0, i).join("");
			const rest = chars.slice(i);

			// With SIMPLIFIEDTRIPLE, `glassko` is glass+sko: the letter the two
			// share is written once.
			const candidates = [left];
			if (this.data.simplified && chars[i - 1] === chars[i]) {
				candidates.push(left + chars[i]);
			}
			for (const seg of candidates) {
				if (this.compoundFrom(seg, rest, word, folded, prev, need, null, depth)) {
					return true;
				}
			}
		}

		// A pattern with a replacement writes the boundary as the replacement:
		// `a/A u/A O` makes sUrya+udayaM into sUryOdayaM.
		for (const p of this.data.patterns) {
			if (p.repl === "") continue;
			const repl = runes(p.repl);
			for (let j = 1; j + repl.length < n; j++) {
				if (chars.slice(j, j + repl.length).join("") !== p.repl) continue;
				const seg = chars.slice(0, j).join("") + p.end;
				const rest = runes(p.begin).concat(chars.slice(j + repl.length));
				if (this.compoundFrom(seg, rest, word, folded, prev, need, p, depth)) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Reports whether `seg`, followed by `rest`, completes a compound.
	 *
	 * `need` is the pattern `seg` has to satisfy the right side of; `next` the
	 * one whose replacement separates `seg` from what follows.
	 */
	private compoundFrom(
		seg: string,
		rest: string[],
		word: string,
		folded: boolean,
		prev: Piece | null,
		need: CompoundPattern | null,
		next: CompoundPattern | null,
		depth: number,
	): boolean {
		const { seg: use, ok } = this.segment(seg);
		const first = prev === null;
		if (
			!ok ||
			(first && !use.begin) ||
			(!first && !use.middle) ||
			(folded && use.keep)
		) {
			return false;
		}
		if (
			need !== null &&
			need.beginFlag !== "" &&
			!hasFlag(use.flags, need.beginFlag)
		) {
			return false;
		}
		if (
			next !== null &&
			((next.endFlag !== "" && !hasFlag(use.flags, next.endFlag)) ||
				(next.stemOnly && use.affixed))
		) {
			return false;
		}
		const cur: Piece = { text: seg, use, sofar: seg };
		if (prev !== null) {
			cur.sofar = prev.sofar + seg;
			if (
				this.patternForbids(prev, cur) ||
				this.repMakesWord(prev.text + seg, cur.sofar)
			) {
				return false;
			}
		}

		const last = rest.join("");
		const { seg: end, ok: isEnd } = this.segment(last);
		if (
			isEnd &&
			end.end &&
			!(folded && end.keep) &&
			!(this.data.checkDup && last === seg) &&
			(!end.upper || initialUpper(word)) &&
			!this.repMakesWord(seg + last, cur.sofar + last)
		) {
			if (next !== null) {
				// Hunspell forbids a duplicate only at the end: foofoobar is
				// fine, foobarbar is not.
				return next.beginFlag === "" || hasFlag(end.flags, next.beginFlag);
			}
			if (!this.patternForbids(cur, { text: last, use: end, sofar: "" })) {
				return true;
			}
		}
		return this.compoundParts(rest, word, folded, cur, next, depth + 1);
	}

	/**
	 * Reports whether CHECKCOMPOUNDREP forbids a compound: one REP
	 * substitution turns a run of its segments into a dictionary word, so the
	 * compound is more likely a typo of that word.
	 */
	private repMakesWord(...texts: string[]): boolean {
		if (!this.data.checkRep) return false;
		for (const text of texts) {
			for (const rep of this.data.reps) {
				for (let at = text.indexOf(rep[0]); at >= 0; ) {
					const candidate =
						text.slice(0, at) + rep[1] + text.slice(at + rep[0].length);
					if (this.isWord(candidate, false)) return true;
					const next = text.slice(at + 1).indexOf(rep[0]);
					if (next < 0) break;
					at += 1 + next;
				}
			}
		}
		return false;
	}

	/** Counts the COMPOUNDSYLLABLE vowels in `word`. */
	private syllables(word: string): number {
		let n = 0;
		for (const r of word) {
			if (this.data.vowels.includes(r)) n++;
		}
		return n;
	}

	/**
	 * Reports whether a CHECKCOMPOUNDPATTERN forbids writing `left` and
	 * `right` together.
	 */
	private patternForbids(left: Piece, right: Piece): boolean {
		for (const p of this.data.patterns) {
			if (p.stemOnly && left.use.affixed) continue;
			if (!left.text.endsWith(p.end) || !right.text.startsWith(p.begin)) {
				continue;
			}
			if (
				(p.endFlag !== "" && !hasFlag(left.use.flags, p.endFlag)) ||
				(p.beginFlag !== "" && !hasFlag(right.use.flags, p.beginFlag))
			) {
				continue;
			}
			return true;
		}
		return false;
	}

	/**
	 * Applies the checks a dictionary asks for at a compound boundary before
	 * `chars[i]`, as the word is written.
	 */
	private boundaryOK(chars: string[], i: number): boolean {
		const before = chars[i - 1] as string;
		const after = chars[i] as string;
		if (this.data.checkTriple) {
			if (
				(i >= 2 && chars[i - 2] === before && before === after) ||
				(i + 1 < chars.length && before === after && after === chars[i + 1])
			) {
				return false;
			}
		}
		if (
			this.data.checkCase &&
			before !== "-" &&
			after !== "-" &&
			(isUpper(before) || isUpper(after))
		) {
			return false;
		}
		return true;
	}

	/** Records a `.dic` entry. */
	private addRoot(word: string, flags: string[]): void {
		const w = this.affix.ignore(word);
		const at = this.data.roots.get(w);
		if (at === undefined) this.data.roots.set(w, [{ flags }]);
		else at.push({ flags });
		this.noteUpper(w);
	}

	/** Indexes a root with a capital, or a ß, by its upper-cased form. */
	private noteUpper(word: string): void {
		if (word === toLower(word) && !this.hasSharp(word)) return;
		const upper = this.upperKey(word);
		const at = this.data.upperRoots.get(upper);
		if (at === undefined) this.data.upperRoots.set(upper, [word]);
		else if (!at.includes(word)) at.push(word);
	}

	/** Loads the entries of a decoded `.dic`; see `newGoSpellReader`. */
	private loadEntries(dic: string): void {
		const affix = this.affix;
		const all = lines(dic);
		// The first line is the entry count, which this port has no use for.
		for (let n = 1; n < all.length; n++) {
			// A .dic entry is `word/flags` optionally followed by whitespace-
			// separated morphological fields, e.g.
			//
			//	abandonware/M	Noun: uncountable
			//	coitus/10,39,31 al:coituum
			//
			// Keep only the first field; otherwise the morphology corrupts flag
			// parsing (FLAG num would read "31 al:coituum" as a flag). Both tab-
			// and space-separated morphology occur in the wild.
			//
			// The word ends at the first tab; morphology follows it.
			const tab = (all[n] as string).indexOf("\t");
			const head = tab < 0 ? (all[n] as string) : (all[n] as string).slice(0, tab);
			const parts = fields(head);
			if (parts.length === 0) continue;

			// A space inside the word makes a pair, `compound word`, whose
			// run-together form is not a compound.
			if (parts.length > 1 && !isMorphField(parts[1] as string)) {
				this.data.pairs.add((parts[0] as string) + (parts[1] as string));
				this.addRoot(`${parts[0]} ${parts[1]}`, []);
				continue;
			}

			const [word, keyString, found] = splitEntry(parts[0] as string);
			if (word === "" || (found && keyString === "")) {
				// Skip a malformed entry (a line with flags but no word) rather
				// than abandoning the dictionary, which would leave every word
				// unrecognized and flagged.
				continue;
			}
			const flags = found ? affix.parseFlags(keyString) : [];

			if (hasFlag(flags, affix.forbiddenFlag)) {
				const forbidden = affix.ignore(word);
				const at = this.data.forbiddenRoots.get(forbidden);
				if (at === undefined) {
					this.data.forbiddenRoots.set(forbidden, [{ flags }]);
				} else {
					at.push({ flags });
				}
				this.noteUpper(forbidden);
				continue;
			}

			for (const key of flags) {
				const words = affix.compoundMap.get(key);
				if (words !== undefined) words.push(word);
			}
			this.addRoot(word, flags);
		}
	}

	/** Builds the COMPOUNDRULE matchers, once every entry is known. */
	private buildCompounds(): void {
		const affix = this.affix;
		for (const compoundRule of affix.compoundRule) {
			// Each flag becomes a group of the words that carry it, and `*` and
			// `?` apply to the group before them.
			let pattern = "^";
			for (const tok of affix.compoundRuleTokens(compoundRule)) {
				if (tok.op !== "") {
					pattern += tok.op;
					continue;
				}
				const words = affix.compoundMap.get(tok.flag) ?? [];
				if (words.length === 0) {
					pattern += "([^\\s\\S])"; // nothing carries the flag
					continue;
				}
				pattern += `(${words.map(quoteMeta).join("|")})`;
			}
			pattern += "$";
			this.data.compounds.push(new RegExp(pattern));
		}
	}

	/** Builds the ICONV replacer, if the `.aff` asked for one. */
	private buildIconv(): void {
		const flat = this.affix.iconvReplacements;
		if (flat.length === 0) return;
		// Hunspell converts by the longest matching rule; the replacer takes
		// the first listed, so the longest are listed first.
		const pairs: Array<[string, string]> = [];
		for (let i = 0; i + 1 < flat.length; i += 2) {
			pairs.push([flat[i] as string, flat[i + 1] as string]);
		}
		pairs.sort((a, b) => b[0].length - a[0].length);
		this.data.ireplacer = new Replacer(pairs);
	}

	/**
	 * A speller over a `.aff` and `.dic` pair already decoded to text, which
	 * is what every other constructor ends up calling.
	 */
	static load(affText: string, dicText: string): GoSpell {
		const affix = newDictConfig(affText);
		const gs = new GoSpell({
			affix,
			roots: new Map(),
			upperRoots: new Map(),
			forbiddenRoots: new Map(),
			pairs: new Set(),
			ireplacer: null,
			compounds: [],
			splitter: new Splitter(affix.wordChars),
			canCompound: affix.compoundingEnabled(),
			compoundMin: affix.compoundMin,
			checkDup: affix.checkCompoundDup,
			checkTriple: affix.checkCompoundTriple,
			simplified: affix.simplifiedTriple,
			checkCase: affix.checkCompoundCase,
			checkRep: affix.checkCompoundRep,
			wordMax: affix.compoundWordMax,
			syllableMax: affix.compoundSyllable,
			vowels: affix.compoundVowels,
			reps: affix.replacements,
			patterns: affix.compoundPatterns,
			breaks: newBreakRules(
				affix.breakDeclared ? affix.breakPatterns : defaultBreaks,
			),
			ignored: affix.ignored,
		});
		gs.loadEntries(dicText);
		gs.buildCompounds();
		gs.buildIconv();
		return gs;
	}
}

/** `i` becomes `İ` and `ı` becomes `I` when a Turkic language is upper-cased. */
const TURKIC_UPPER = new Replacer([
	["i", "İ"],
	["ı", "I"],
]);
/** The same the other way round. */
const TURKIC_LOWER = new Replacer([
	["İ", "i"],
	["I", "ı"],
]);
/** Under CHECKSHARPS, an all-caps word writes ß as SS. */
const SHARP_UPPER = new Replacer([
	["ß", "SS"],
	["ẞ", "SS"],
]);

/**
 * A speller over a dictionary pair held in memory, so the package works
 * without touching disk.
 *
 * The text is read in the encoding the `.aff` declares, exactly as a file
 * would be: a `SET ISO8859-1` pair is interpreted from the bytes the text
 * would be written as, so an in-memory dictionary and the same one on disk
 * behave alike.
 */
export function newGoSpellReader(aff: string, dic: string): GoSpell {
	const decoded = decodeDictionaryText(aff, dic);
	return GoSpell.load(decoded.aff, decoded.dic);
}

/** A speller over the dictionary pair held as bytes. */
export function newGoSpellBytes(aff: Uint8Array, dic: Uint8Array): GoSpell {
	const decoded = decodeDictionary(aff, dic);
	return GoSpell.load(decoded.aff, decoded.dic);
}

/** A speller over the AFF and DIC Hunspell files at the given paths. */
export function newGoSpell(affFile: string, dicFile: string): GoSpell {
	let aff: Uint8Array;
	try {
		aff = readBinaryFile(affFile);
	} catch (err) {
		throw new Error(`unable to open aff: ${(err as Error).message}`);
	}
	let dic: Uint8Array;
	try {
		dic = readBinaryFile(dicFile);
	} catch (err) {
		throw new Error(`unable to open dic: ${(err as Error).message}`);
	}
	return newGoSpellBytes(aff, dic);
}

/**
 * Reads a file as bytes, through `node:fs` so the package works the same
 * under Bun and Node.
 */
export function readBinaryFile(path: string): Uint8Array {
	const buf = readFileSync(path);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Reads a file as UTF-8 text. */
export function readTextFile(path: string): string {
	return new TextDecoder("utf-8").decode(readBinaryFile(path));
}
