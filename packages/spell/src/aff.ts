/**
 * The Hunspell `.aff` reader and the affix engine that expands a `.dic`
 * entry into the words it stands for.
 *
 * A `.aff` is data the checker is handed, so a directive it cannot use never
 * reaches the code that would trust it: a count only preallocates, a length
 * is bounded, and a directive this reader does not implement is recorded by
 * name instead of being silently dropped.
 */

import {
	allDigits,
	fields,
	isLetter,
	lines,
	parseInt64,
	runes,
	toUpper,
	utf8Bytes,
} from "./text.ts";

/** Which end of a word an affix class attaches to. */
export type AffixType = "prefix" | "suffix";

export const Prefix: AffixType = "prefix";
export const Suffix: AffixType = "suffix";

/** One affix rule: what it strips, what it adds, and when it applies. */
export interface Rule {
	strip: string;
	/** The suffix or prefix text to add. */
	affixText: string;

	/**
	 * The continuation flags the rule carries, if any -- the "34,22" of
	 * `SFX 1 0 t/34,22 e`. They name the affix classes that apply again to
	 * the form this rule produces, which is how a dictionary spells out an
	 * inflection built in more than one step.
	 */
	cont: string;

	/** The matching condition as the `.aff` wrote it. */
	pattern: string;
	/** The condition compiled, or null when it matches anything. */
	matcher: RegExp | null;
}

/** An affix class: a rule set that adds prefixes or suffixes. */
export interface Affix {
	rules: Rule[];
	/** Either PFX or SFX. */
	type: AffixType;
	crossProduct: boolean;
}

/**
 * One word an entry generates: the flags it carries, from the stem and every
 * rule applied, and the affixes it was built with.
 */
export interface EntryForm {
	word: string;
	flags: string[];

	/** null when none was applied. */
	prefix: Rule | null;
	suffix: Rule | null;
	/** The flags of the rule that built it. */
	cont: string[];

	/**
	 * Set by NEEDAFFIX on the stem or a rule; `plainAffix` is set by a rule
	 * without it, which satisfies the want.
	 */
	wantsAffix: boolean;
	plainAffix: boolean;

	/**
	 * The affix type of a CIRCUMFIX rule still waiting for its partner of
	 * the other type.
	 */
	open: AffixType | null;
}

/** Reports whether `f` is only a step toward another form. */
function virtual(f: EntryForm): boolean {
	return f.open !== null || (f.wantsAffix && !f.plainAffix);
}

/** `a` followed by what `b` adds to it. */
export function union(a: readonly string[], b: readonly string[]): string[] {
	const out = a.slice();
	for (const x of b) {
		if (!out.includes(x)) out.push(x);
	}
	return out;
}

/** Hunspell's own default for COMPOUNDMIN. */
export const defaultCompoundMin = 3;
/**
 * Where a COMPOUNDMIN stops being a plausible word length and starts being a
 * typo or worse.
 */
const maxCompoundMin = 100;
/** How many BREAK patterns are kept; a real dictionary declares a handful. */
const maxBreakRules = 64;

/**
 * How many times a continuation class may be followed.
 *
 * Hunspell's default is twofold affixation -- one continuation -- and this
 * allows one more for dictionaries that lean on longer chains. A bound is
 * what makes this safe at all: nothing stops an `.aff` file from having a
 * class continue to itself, and following that faithfully would not
 * terminate.
 */
export const maxAffixDepth = 2;

/** What a form may do in a compound. */
export interface Segment {
	begin: boolean;
	middle: boolean;
	end: boolean;
	/** FORCEUCASE: a compound ending here is capitalized. */
	upper: boolean;
	/** KEEPCASE: not part of a case-folded compound. */
	keep: boolean;
	/** Built with an affix, which a `0` pattern excludes. */
	affixed: boolean;
	/** For the flags a CHECKCOMPOUNDPATTERN names. */
	flags: string[];
}

export function emptySegment(): Segment {
	return {
		begin: false,
		middle: false,
		end: false,
		upper: false,
		keep: false,
		affixed: false,
		flags: [],
	};
}

/** Combines what two forms of the same word may do. */
export function mergeSegments(s: Segment, o: Segment): Segment {
	return {
		begin: s.begin || o.begin,
		middle: s.middle || o.middle,
		end: s.end || o.end,
		upper: s.upper || o.upper,
		keep: s.keep || o.keep,
		affixed: s.affixed && o.affixed,
		flags: union(s.flags, o.flags),
	};
}

/**
 * One CHECKCOMPOUNDPATTERN line: a boundary that is forbidden as written, and
 * may be written as `repl` instead.
 */
export interface CompoundPattern {
	/** What the left segment ends with and the right one begins with. */
	end: string;
	begin: string;
	/** The flags each must carry, if any. */
	endFlag: string;
	beginFlag: string;
	/** `0`: the left segment is an unaffixed stem. */
	stemOnly: boolean;
	repl: string;
}

/** One element of a COMPOUNDRULE: a flag, or the `*` or `?` that follows one. */
export interface RuleToken {
	flag: string;
	op: string;
}

/** Reports whether `flag` is set and among `flags`. */
export function hasFlag(flags: readonly string[], flag: string): boolean {
	return flag !== "" && flags.includes(flag);
}

/**
 * Turns an affix condition into a regular expression.
 *
 * A hyphen inside a Hunspell class is a literal, never a range.
 */
export function conditionPattern(cond: string): string {
	let out = "";
	let inClass = false;
	for (const r of cond) {
		if (r === "[") inClass = true;
		else if (r === "]") inClass = false;
		else if (r === "-" && inClass) {
			out += "\\-";
			continue;
		}
		out += r;
	}
	return out;
}

/**
 * Reads `chars[/flag]`, returning the characters, the flag, and whether `0`
 * asked for an unaffixed stem.
 */
function parsePatternSide(s: string): [string, string, boolean] {
	const at = s.indexOf("/");
	const chars = at < 0 ? s : s.slice(0, at);
	const flag = at < 0 ? "" : s.slice(at + 1);
	if (chars === "0") return ["", flag, true];
	return [chars, flag, false];
}

function isCrossProduct(val: string): boolean {
	if (val === "Y") return true;
	if (val === "N") return false;
	throw new Error(`CrossProduct is not Y or N: got "${val}"`);
}

/** Locates one rule of one affix class. */
export interface AffixRef {
	flag: string;
	idx: number;
}

/**
 * Finds the rules that could have added a word's ending or beginning; the
 * upper-cased keys serve an all-caps word.
 */
export interface ReverseIndex {
	suffix: Map<string, AffixRef[]>;
	prefix: Map<string, AffixRef[]>;
	suffixUpper: Map<string, AffixRef[]>;
	prefixUpper: Map<string, AffixRef[]>;
	maxSuffix: number;
	maxPrefix: number;
}

export function emptyIndex(): ReverseIndex {
	return {
		suffix: new Map(),
		prefix: new Map(),
		suffixUpper: new Map(),
		prefixUpper: new Map(),
		maxSuffix: 0,
		maxPrefix: 0,
	};
}

function push(m: Map<string, AffixRef[]>, key: string, ref: AffixRef): void {
	const at = m.get(key);
	if (at === undefined) m.set(key, [ref]);
	else at.push(ref);
}

/** Indexes the affix rules by the text they add. */
export function buildIndex(a: DictConfig): void {
	const idx = emptyIndex();
	for (const [flag, af] of a.affixMap) {
		for (let i = 0; i < af.rules.length; i++) {
			const r = af.rules[i] as Rule;
			const ref: AffixRef = { flag, idx: i };
			const upper = toUpper(r.affixText);
			if (af.type === "prefix") {
				push(idx.prefix, r.affixText, ref);
				push(idx.prefixUpper, upper, ref);
				idx.maxPrefix = Math.max(idx.maxPrefix, r.affixText.length, upper.length);
			} else {
				push(idx.suffix, r.affixText, ref);
				push(idx.suffixUpper, upper, ref);
				idx.maxSuffix = Math.max(idx.maxSuffix, r.affixText.length, upper.length);
			}
		}
	}
	a.index = idx;
}

/** A partial representation of a Hunspell AFF (Affix) file. */
export class DictConfig {
	iconvReplacements: string[] = [];
	replacements: Array<[string, string]> = [];
	compoundRule: string[] = [];
	breakPatterns: string[] = [];
	flag = "ASCII";
	tryChars = "";
	wordChars = "";
	compoundOnly = "";
	compoundFlag = "";
	compoundBegin = "";
	compoundMiddle = "";
	compoundEnd = "";
	affixMap = new Map<string, Affix>();
	camelCase = 0;
	compoundMin = defaultCompoundMin;
	compoundMap = new Map<string, string[]>();
	noSuggestFlag = "";
	/** FORBIDDENWORD: the entry's forms are not words. */
	forbiddenFlag = "";
	/** NEEDAFFIX: the bare stem is not a word. */
	needAffixFlag = "";
	/** KEEPCASE: accepted only as written. */
	keepCaseFlag = "";
	/** CIRCUMFIX: a prefix and suffix that go together. */
	circumfixFlag = "";
	/** COMPOUNDPERMITFLAG: an affix allowed inside a compound. */
	compoundPermitFlag = "";
	/** COMPOUNDFORBIDFLAG: a form kept out of compounds. */
	compoundForbidFlag = "";
	/** FORCEUCASE: a compound ending here is capitalized. */
	forceUCaseFlag = "";
	/** AF: flag sets that an entry names by number. */
	aliases: string[] = [];
	/** IGNORE: characters dropped from words and affixes. */
	ignoreChars = "";
	/** CHECKSHARPS: an all-caps word writes ß as SS. */
	checkSharps = false;
	/** LANG: Turkic casing when it starts with tr, az, or crh. */
	lang = "";

	/** Any BREAK line; otherwise Hunspell's defaults apply. */
	breakDeclared = false;
	/** CHECKCOMPOUNDDUP: no segment twice in a row. */
	checkCompoundDup = false;
	/** CHECKCOMPOUNDTRIPLE: no letter three times at a boundary. */
	checkCompoundTriple = false;
	/** SIMPLIFIEDTRIPLE: a triple may be written as a double. */
	simplifiedTriple = false;
	/** CHECKCOMPOUNDCASE: no upper-case letter at a boundary. */
	checkCompoundCase = false;
	/** CHECKCOMPOUNDREP: no compound a REP entry turns into a word. */
	checkCompoundRep = false;
	/** COMPOUNDWORDMAX: segments a compound may have; 0 is no limit. */
	compoundWordMax = 0;

	/**
	 * COMPOUNDSYLLABLE: a compound of more segments than COMPOUNDWORDMAX is
	 * allowed when it has no more syllables than this, counted as vowels.
	 */
	compoundSyllable = 0;
	compoundVowels = "";
	compoundPatterns: CompoundPattern[] = [];

	/**
	 * The directives the file used that this reader does not implement, in
	 * the order they were first seen.
	 */
	ignored: string[] = [];

	index: ReverseIndex = emptyIndex();

	/**
	 * A flag is one byte, as Hunspell reads them from a UTF-8 file without
	 * FLAG: a non-ASCII flag character is then two flags, and a class name is
	 * its first byte.
	 */
	byteFlags = true;

	/**
	 * Reports whether the dictionary uses affix-flag-based compounding
	 * (COMPOUNDFLAG / COMPOUNDBEGIN / MIDDLE / END), as German, Dutch and
	 * others do. COMPOUNDRULE is handled separately.
	 */
	compoundingEnabled(): boolean {
		return (
			this.compoundFlag !== "" ||
			this.compoundBegin !== "" ||
			this.compoundMiddle !== "" ||
			this.compoundEnd !== ""
		);
	}

	/**
	 * Splits a flag string into individual flags based on the FLAG type.
	 *
	 * Hunspell supports several formats:
	 *   - "ASCII" (default): each character is a flag
	 *   - "num": flags are comma-separated numbers, `14308,10482,4720`
	 *   - "UTF-8": each UTF-8 character is a flag
	 *   - "long": each pair of ASCII characters is a flag
	 */
	parseFlags(flagStr: string): string[] {
		let s = flagStr;
		// With AF, an entry's flags are the number of an alias line.
		if (this.aliases.length > 0 && allDigits(s)) {
			const n = Number(s);
			if (!Number.isFinite(n) || n < 1 || n > this.aliases.length) return [];
			s = this.aliases[n - 1] as string;
		}
		switch (this.flag) {
			case "num":
				return s.split(",");
			case "long": {
				const bytes = utf8Bytes(s);
				const flags: string[] = [];
				for (let i = 0; i + 1 < bytes.length; i += 2) {
					flags.push((bytes[i] as string) + (bytes[i + 1] as string));
				}
				return flags;
			}
			case "UTF-8":
				return runes(s);
			default:
				return this.byteFlags ? utf8Bytes(s) : runes(s);
		}
	}

	/**
	 * Splits a COMPOUNDRULE.
	 *
	 * A flag in parentheses may be several characters, as FLAG long and num
	 * need; any other is one flag.
	 */
	compoundRuleTokens(rule: string): RuleToken[] {
		const units = this.byteFlags ? utf8Bytes(rule) : runes(rule);
		const out: RuleToken[] = [];
		for (let i = 0; i < units.length; ) {
			const c = units[i] as string;
			if (c === "*" || c === "?") {
				out.push({ flag: "", op: c });
				i++;
				continue;
			}
			if (c === "(") {
				const end = units.indexOf(")", i);
				if (end < 0) {
					out.push({ flag: units.slice(i + 1).join(""), op: "" });
					return out;
				}
				out.push({ flag: units.slice(i + 1, end).join(""), op: "" });
				i = end + 1;
				continue;
			}
			out.push({ flag: c, op: "" });
			i++;
		}
		return out;
	}

	/** Reads a directive that names one flag. */
	singleFlag(s: string): string {
		const flags = this.parseFlags(s);
		return flags.length > 0 ? (flags[0] as string) : s;
	}

	/** The words a `.dic` entry generates. */
	expand(entry: string): string[] {
		return this.expandEntry(entry).map((f) => f.word);
	}

	/** Every form a `.dic` entry generates, with its flags. */
	expandEntry(entry: string): EntryForm[] {
		const at = entry.indexOf("/");
		if (at < 0) return [newForm(entry, [])];
		const word = entry.slice(0, at);
		const keyString = entry.slice(at + 1);
		if (word === "" || keyString === "") {
			throw new Error("slash char found in first or last position");
		}
		return this.expander(null, null).root(word, this.parseFlags(keyString));
	}

	/**
	 * An expander over this configuration. With `allowed` set, only forms
	 * whose key is in it are kept, which confines the walk to the path toward
	 * one word.
	 */
	expander(
		allowed: ReadonlySet<string> | null,
		key: ((s: string) => string) | null,
	): Expander {
		return new Expander(this, allowed, key ?? ((s) => s));
	}

	/** Reports whether `f` may be a compound segment, and where. */
	compoundUse(f: EntryForm): Segment | null {
		if (hasFlag(f.flags, this.compoundForbidFlag)) return null;
		const anywhere = hasFlag(f.flags, this.compoundFlag);
		const seg: Segment = {
			begin: anywhere || hasFlag(f.flags, this.compoundBegin),
			middle: anywhere || hasFlag(f.flags, this.compoundMiddle),
			end: anywhere || hasFlag(f.flags, this.compoundEnd),
			upper: hasFlag(f.flags, this.forceUCaseFlag),
			keep: false,
			affixed: f.prefix !== null || f.suffix !== null,
			flags: f.flags,
		};
		// An affix keeps its form at the compound's edge unless it permits more.
		if (
			f.prefix !== null &&
			!hasFlag(this.parseFlags(f.prefix.cont), this.compoundPermitFlag)
		) {
			seg.middle = false;
			seg.end = false;
		}
		if (f.suffix !== null) {
			const cont = this.parseFlags(f.suffix.cont);
			if (!hasFlag(cont, this.compoundPermitFlag)) {
				seg.begin = false;
				seg.middle = false;
			}
			// A suffix only for compounds, a Fuge-s, ends a compound only if it
			// says so itself.
			if (
				hasFlag(cont, this.compoundOnly) &&
				!hasFlag(cont, this.compoundFlag) &&
				!hasFlag(cont, this.compoundEnd)
			) {
				seg.end = false;
			}
		}
		if (!seg.begin && !seg.middle && !seg.end) return null;
		return seg;
	}

	/** `s` without the IGNORE characters. */
	ignore(s: string): string {
		if (this.ignoreChars === "") return s;
		let out = "";
		for (const r of s) {
			if (!this.ignoreChars.includes(r)) out += r;
		}
		return out;
	}

	/**
	 * Takes the IGNORE characters out of the affix texts, as they are taken
	 * out of every word.
	 */
	dropIgnored(): void {
		if (this.ignoreChars === "") return;
		for (const af of this.affixMap.values()) {
			for (const rule of af.rules) {
				rule.affixText = this.ignore(rule.affixText);
				rule.strip = this.ignore(rule.strip);
			}
		}
	}
}

function newForm(word: string, flags: string[]): EntryForm {
	return {
		word,
		flags,
		prefix: null,
		suffix: null,
		cont: [],
		wantsAffix: false,
		plainAffix: false,
		open: null,
	};
}

/** Generates a root's forms; see `DictConfig.expander`. */
export class Expander {
	private readonly a: DictConfig;
	private readonly allowed: ReadonlySet<string> | null;
	private readonly key: (s: string) => string;

	constructor(
		a: DictConfig,
		allowed: ReadonlySet<string> | null,
		key: (s: string) => string,
	) {
		this.a = a;
		this.allowed = allowed;
		this.key = key;
	}

	/** The forms of a root with the given flags. */
	root(word: string, flags: string[]): EntryForm[] {
		const stem = newForm(word, flags);
		stem.cont = flags;
		stem.wantsAffix = hasFlag(flags, this.a.needAffixFlag);
		return this.emit(stem, 0);
	}

	/**
	 * `f`, unless it is only a step toward another form, and then the forms
	 * the affixes its flags name build on it.
	 */
	private emit(f: EntryForm, depth: number): EntryForm[] {
		const out: EntryForm[] = [];
		if (!virtual(f)) out.push(f);
		if (depth > maxAffixDepth) return out;
		return out.concat(this.affixed(f, f.cont, depth));
	}

	/** The forms the affixes named by `keys` make from `base`. */
	private affixed(
		base: EntryForm,
		keys: readonly string[],
		depth: number,
	): EntryForm[] {
		let out: EntryForm[] = [];
		const prefixes: Affix[] = [];
		const suffixes: Affix[] = [];
		for (const key of keys) {
			const af = this.a.affixMap.get(key);
			if (af === undefined) continue;
			if (!af.crossProduct) {
				out = this.emitAll(this.derive(af, base), out, depth);
				continue;
			}
			if (af.type === Prefix) prefixes.push(af);
			else suffixes.push(af);
		}

		for (const suf of suffixes) {
			out = this.emitAll(this.derive(suf, base), out, depth);
		}
		for (const pre of prefixes) {
			const prefixed = this.derive(pre, base);
			out = this.emitAll(prefixed, out, depth);

			// now do cross product
			for (const suf of suffixes) {
				for (const pw of prefixed) {
					out = this.emitAll(this.derive(suf, pw), out, depth);
				}
			}
		}
		return out;
	}

	/**
	 * Emits each form, following its continuation flags one level down.
	 *
	 * This is the step Hunspell calls twofold affixation: `SFX 1 0 t/34,22 e`
	 * says that after the rule builds its form, classes 34 and 22 apply to
	 * that.
	 */
	private emitAll(
		forms: EntryForm[],
		out: EntryForm[],
		depth: number,
	): EntryForm[] {
		let acc = out;
		for (const f of forms) acc = acc.concat(this.emit(f, depth + 1));
		return acc;
	}

	/** Applies the affix's rules to `base`, one form per rule that matches. */
	private derive(af: Affix, base: EntryForm): EntryForm[] {
		const a = this.a;
		const out: EntryForm[] = [];
		for (const r of af.rules) {
			// The condition is tested last: building the form and checking it
			// against `allowed` is cheaper than the regular expression.
			const f: EntryForm = { ...base, cont: [] };
			if (r.cont !== "") {
				f.cont = a.parseFlags(r.cont);
				f.flags = union(base.flags, f.cont);
			}
			if (hasFlag(f.cont, a.needAffixFlag)) f.wantsAffix = true;
			else f.plainAffix = true;
			if (hasFlag(f.cont, a.circumfixFlag)) {
				if (base.open !== null && base.open !== af.type) {
					f.open = null; // paired
				} else {
					f.open = af.type;
				}
			}
			if (af.type === Prefix) {
				let stripped = base.word;
				if (r.strip !== "" && stripped.startsWith(r.strip)) {
					stripped = stripped.slice(r.strip.length);
				}
				f.word = r.affixText + stripped;
				f.prefix = r;
			} else {
				let stripped = base.word;
				if (r.strip !== "" && stripped.endsWith(r.strip)) {
					stripped = stripped.slice(0, stripped.length - r.strip.length);
				}
				f.word = stripped + r.affixText;
				f.suffix = r;
			}
			if (this.allowed !== null && !this.allowed.has(this.key(f.word))) {
				continue;
			}
			if (r.matcher !== null && !r.matcher.test(base.word)) continue;
			out.push(f);
		}
		return out;
	}
}

/** Reads a Hunspell AFF file. */
export function newDictConfig(file: string): DictConfig {
	const aff = new DictConfig();
	let sawBreakCount = false;
	let sawAliasCount = false;

	for (const line of lines(file)) {
		const parts = fields(line);
		if (parts.length === 0) continue;

		const directive = parts[0] as string;
		switch (directive) {
			case "SET":
				// Decoded before parsing; see decodeDictionary. A UTF-8 file's
				// flags are bytes unless FLAG says otherwise.
				if (parts.length >= 2) {
					const upper = (parts[1] as string).toUpperCase();
					aff.byteFlags = upper === "UTF-8" || upper === "UTF8";
				}
				break;
			case "TRY":
				if (parts.length < 2) {
					throw new Error(`TRY stanza had ${parts.length} fields, expected 2`);
				}
				aff.tryChars = parts[1] as string;
				break;
			case "ICONV":
				// If there are only 2 fields it is the first stanza, which just
				// provides a count; we don't care, as we allocate as we go.
				if (parts.length === 2) continue;
				if (parts.length < 3) {
					throw new Error(`ICONV stanza had ${parts.length} fields, expected 2`);
				}
				aff.iconvReplacements.push(parts[1] as string, parts[2] as string);
				break;
			case "REP":
				if (parts.length === 2) continue;
				if (parts.length < 3) {
					throw new Error(`REP stanza had ${parts.length} fields, expected 2`);
				}
				aff.replacements.push([parts[1] as string, parts[2] as string]);
				break;
			case "COMPOUNDMIN": {
				if (parts.length < 2) {
					throw new Error(
						`COMPOUNDMIN stanza had ${parts.length} fields, expected 2`,
					);
				}
				// Parsed at a fixed width: the line between a clamped
				// COMPOUNDMIN and a rejected one must not depend on the host.
				const val = parseInt64(parts[1] as string);
				if (val === null) {
					throw new Error(`COMPOUNDMIN stanza had "${parts[1]}" expected number`);
				}
				// Hunspell ignores a value outside this range and uses its
				// default rather than refusing the dictionary; an absurd length
				// is not worth failing over. Bounding it here is also what keeps
				// the value safe to use as a length below.
				aff.compoundMin = defaultCompoundMin;
				if (val >= 1n && val <= BigInt(maxCompoundMin)) {
					aff.compoundMin = Number(val);
				}
				break;
			}
			case "ONLYINCOMPOUND":
				if (parts.length < 2) {
					throw new Error(
						`ONLYINCOMPOUND stanza had ${parts.length} fields, expected 2`,
					);
				}
				aff.compoundOnly = aff.singleFlag(parts[1] as string);
				break;
			case "COMPOUNDRULE": {
				if (parts.length < 2) {
					throw new Error(
						`COMPOUNDRULE stanza had ${parts.length} fields, expected 2`,
					);
				}
				const val = parseInt64(parts[1] as string);
				if (val !== null) {
					// A count read from the file, which this port has no use for:
					// the list grows on its own.
					aff.compoundRule = [];
					break;
				}
				const rule = parts[1] as string;
				aff.compoundRule.push(rule);
				for (const tok of aff.compoundRuleTokens(rule)) {
					if (tok.flag !== "" && !aff.compoundMap.has(tok.flag)) {
						aff.compoundMap.set(tok.flag, []);
					}
				}
				break;
			}
			case "NOSUGGEST":
				if (parts.length < 2) {
					throw new Error(
						`NOSUGGEST stanza had ${parts.length} fields, expected 2`,
					);
				}
				aff.noSuggestFlag = aff.singleFlag(parts[1] as string);
				break;
			case "FORBIDDENWORD":
				if (parts.length >= 2) {
					aff.forbiddenFlag = aff.singleFlag(parts[1] as string);
				}
				break;
			case "NEEDAFFIX":
			case "PSEUDOROOT":
				if (parts.length >= 2) {
					aff.needAffixFlag = aff.singleFlag(parts[1] as string);
				}
				break;
			case "KEEPCASE":
				if (parts.length >= 2) {
					aff.keepCaseFlag = aff.singleFlag(parts[1] as string);
				}
				break;
			case "CIRCUMFIX":
				if (parts.length >= 2) {
					aff.circumfixFlag = aff.singleFlag(parts[1] as string);
				}
				break;
			case "CHECKCOMPOUNDDUP":
				aff.checkCompoundDup = true;
				break;
			case "CHECKCOMPOUNDTRIPLE":
				aff.checkCompoundTriple = true;
				break;
			case "SIMPLIFIEDTRIPLE":
				aff.simplifiedTriple = true;
				break;
			case "CHECKCOMPOUNDCASE":
				aff.checkCompoundCase = true;
				break;
			case "CHECKCOMPOUNDREP":
				aff.checkCompoundRep = true;
				break;
			case "COMPOUNDWORDMAX": {
				if (parts.length < 2) break;
				const val = parseInt64(parts[1] as string);
				if (val !== null && val > 0n && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
					aff.compoundWordMax = Number(val);
				}
				break;
			}
			case "COMPOUNDSYLLABLE": {
				if (parts.length < 3) break;
				const val = parseInt64(parts[1] as string);
				if (val !== null && val > 0n && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
					aff.compoundSyllable = Number(val);
					aff.compoundVowels = parts[2] as string;
				}
				break;
			}
			case "CHECKCOMPOUNDPATTERN": {
				// The first line is a count.
				if (parts.length === 2 && allDigits(parts[1] as string)) continue;
				if (parts.length < 3) {
					throw new Error(
						`CHECKCOMPOUNDPATTERN stanza had ${parts.length} fields, expected 3`,
					);
				}
				const [end, endFlag, stemOnly] = parsePatternSide(parts[1] as string);
				const [begin, beginFlag] = parsePatternSide(parts[2] as string);
				aff.compoundPatterns.push({
					end,
					endFlag,
					stemOnly,
					begin,
					beginFlag,
					repl: parts.length > 3 ? (parts[3] as string) : "",
				});
				break;
			}
			case "CHECKSHARPS":
				aff.checkSharps = true;
				break;
			case "LANG":
				if (parts.length >= 2) aff.lang = parts[1] as string;
				break;
			case "IGNORE":
				if (parts.length >= 2) aff.ignoreChars = parts[1] as string;
				break;
			case "AF":
				if (parts.length < 2) {
					throw new Error(`AF stanza had ${parts.length} fields, expected 2`);
				}
				// The first AF line is a count, which this port has no use for.
				if (!sawAliasCount && allDigits(parts[1] as string)) {
					sawAliasCount = true;
					continue;
				}
				aff.aliases.push(parts[1] as string);
				break;
			case "COMPOUNDFLAG":
				if (parts.length >= 2) {
					aff.compoundFlag = aff.singleFlag(parts[1] as string);
				}
				break;
			case "COMPOUNDBEGIN":
				if (parts.length >= 2) {
					aff.compoundBegin = aff.singleFlag(parts[1] as string);
				}
				break;
			case "COMPOUNDMIDDLE":
				if (parts.length >= 2) {
					aff.compoundMiddle = aff.singleFlag(parts[1] as string);
				}
				break;
			case "COMPOUNDEND":
				if (parts.length >= 2) {
					aff.compoundEnd = aff.singleFlag(parts[1] as string);
				}
				break;
			case "COMPOUNDPERMITFLAG":
				if (parts.length >= 2) {
					aff.compoundPermitFlag = aff.singleFlag(parts[1] as string);
				}
				break;
			case "COMPOUNDFORBIDFLAG":
				if (parts.length >= 2) {
					aff.compoundForbidFlag = aff.singleFlag(parts[1] as string);
				}
				break;
			case "FORCEUCASE":
				if (parts.length >= 2) {
					aff.forceUCaseFlag = aff.singleFlag(parts[1] as string);
				}
				break;
			case "WORDCHARS":
				if (parts.length < 2) {
					throw new Error(`WORDCHAR stanza had ${parts.length} fields, expected 2`);
				}
				aff.wordChars = parts[1] as string;
				break;
			case "BREAK":
				if (parts.length < 2) {
					throw new Error(`BREAK stanza had ${parts.length} fields, expected 2`);
				}
				// The first BREAK line is a count; the rest are patterns.
				aff.breakDeclared = true;
				if (!sawBreakCount && allDigits(parts[1] as string)) {
					sawBreakCount = true;
					continue;
				}
				if (aff.breakPatterns.length < maxBreakRules) {
					aff.breakPatterns.push(parts[1] as string);
				}
				break;
			case "FLAG":
				if (parts.length < 2) {
					throw new Error(`FLAG stanza had ${parts.length}, expected 1`);
				}
				aff.flag = parts[1] as string;
				break;
			case "PFX":
			case "SFX": {
				const atype: AffixType = directive === "SFX" ? Suffix : Prefix;
				const sections = parts.length;

				// A header line is `PFX/SFX flag Y|N count`; a rule line is
				// `PFX/SFX flag strip affix [condition]`. They can both have four
				// fields -- some dictionaries (e.g. OpenTaal's Dutch) omit the
				// rule's condition -- so distinguish by the cross-product flag
				// rather than by field count alone.
				const isHeader =
					sections >= 4 &&
					(parts[2] === "Y" || parts[2] === "N") &&
					allDigits(parts[3] as string);
				if (isHeader) {
					// this is a new Affix!
					aff.affixMap.set(aff.singleFlag(parts[1] as string), {
						type: atype,
						crossProduct: isCrossProduct(parts[2] as string),
						rules: [],
					});
					break;
				}
				if (sections < 4) break;

				const flag = aff.singleFlag(parts[1] as string);
				const a = aff.affixMap.get(flag);
				// Hunspell skips a rule whose class was never declared.
				if (a === undefined) break;

				const strip = parts[2] === "0" ? "" : (parts[2] as string);

				// The condition is optional; default to "." (matches anything)
				// when a dictionary omits it.
				const cond = sections > 4 ? (parts[4] as string) : ".";

				let matcher: RegExp | null = null;
				if (cond !== ".") {
					let pat = conditionPattern(cond);
					pat = a.type === Prefix ? `^${pat}` : `${pat}$`;
					try {
						matcher = new RegExp(pat);
					} catch {
						throw new Error(`unable to compile ${pat}`);
					}
				}

				// Split off the affix's own continuation flags, e.g. the "/34,22"
				// in `SFX 1 0 t/34,22 e`. Left in place they would be appended to
				// the generated word ("stavet/34,22"), so the real form
				// ("stavet") is never recognized.
				//
				// They are kept rather than dropped: the flags name further
				// classes that apply to the form this rule produces, which is how
				// Hunspell builds a word like `stavets` from `stave` in two steps.
				let affixText = parts[3] as string;
				let cont = "";
				const slash = affixText.indexOf("/");
				if (slash >= 0) {
					cont = affixText.slice(slash + 1);
					affixText = affixText.slice(0, slash);
				}
				// A zero affix, which may still carry flags: `0/UPX`.
				if (affixText === "0") affixText = "";

				a.rules.push({ strip, affixText, cont, pattern: cond, matcher });
				break;
			}
			default: {
				// Hunspell ignores lines that don't start with a directive; a
				// directive it knows and this reader does not is recorded.
				if (!directive.startsWith("#") && !aff.ignored.includes(directive)) {
					aff.ignored.push(directive);
				}
			}
		}
	}

	aff.dropIgnored();
	buildIndex(aff);
	return aff;
}

/**
 * Reports whether a `.dic` field is morphology, `po:noun`.
 *
 * Go indexes the field by byte here; this port indexes it by code unit, which
 * differs only for a field whose first two characters are not ASCII -- and a
 * morphology tag is written in ASCII.
 */
export function isMorphField(field: string): boolean {
	return (
		field.length > 2 &&
		field[2] === ":" &&
		isLetter(field[0] as string) &&
		isLetter(field[1] as string)
	);
}
