/**
 * Reading a word back to the roots that could have produced it, so a
 * dictionary's forms are generated on lookup rather than at load.
 *
 * Expanding every entry of an inflected language's dictionary up front costs
 * more memory than the dictionary itself. Instead the affix rules are indexed
 * by the text they add, a lookup walks back from the word to the strings that
 * could be steps toward it, and only the roots among those are expanded --
 * with the walk confined to the forms that lead to the word being looked up.
 */

import type { AffixRef, AffixType, DictConfig, EntryForm, Rule } from "./aff.ts";
import { maxAffixDepth } from "./aff.ts";
import { toUpper } from "./text.ts";

/**
 * How many affixes a word may be read back through: a prefix and a suffix at
 * each of the levels expansion follows.
 */
const maxAffixOps = 2 * (maxAffixDepth + 1);

/** One `.dic` line's flags. */
export interface RootEntry {
	flags: string[];
}

/**
 * A string on the way back from a word to a root, with the affix flags
 * whoever produced it must carry: the class of each affix taken off since the
 * last continuation, at most a prefix and a suffix.
 */
interface RevState {
	text: string;
	/** The flags, joined. */
	needs: string;
}

/** The separator that makes a `RevState` a map key. */
const STATE_SEP = "\u0001";

/**
 * `word` and every string that could be a step on the way to it: what remains
 * after taking an affix's added text off and putting its stripped text back,
 * up to `maxAffixOps` times, along paths the flags allow.
 *
 * With `fold`, the affix texts are matched upper-cased, for an all-caps word.
 */
export function reverseSet(
	a: DictConfig,
	word: string,
	fold: boolean,
): Set<string> {
	const idx = a.index;
	const sufIdx = fold ? idx.suffixUpper : idx.suffix;
	const preIdx = fold ? idx.prefixUpper : idx.prefix;
	const strip = (r: Rule): string => (fold ? toUpper(r.strip) : r.strip);

	const allowed = new Set<string>([word]);
	const seen = new Set<string>([word + STATE_SEP]);
	let frontier: RevState[] = [{ text: word, needs: "" }];

	for (let ops = 0; ops < maxAffixOps && frontier.length > 0; ops++) {
		const next: RevState[] = [];
		const visit = (st: RevState, base: string, ref: AffixRef, r: Rule): void => {
			if (base === "") return;
			if (!fold && r.matcher !== null && !r.matcher.test(base)) return;
			for (const needs of nextNeeds(a, st.needs, ref, r)) {
				const key = base + STATE_SEP + needs;
				if (seen.has(key)) continue;
				seen.add(key);
				allowed.add(base);
				next.push({ text: base, needs });
			}
		};
		for (const st of frontier) {
			const s = st.text;
			for (let l = 0; l <= idx.maxSuffix && l <= s.length; l++) {
				for (const ref of sufIdx.get(s.slice(s.length - l)) ?? []) {
					const r = ruleAt(a, ref);
					visit(st, s.slice(0, s.length - l) + strip(r), ref, r);
				}
			}
			for (let l = 0; l <= idx.maxPrefix && l <= s.length; l++) {
				for (const ref of preIdx.get(s.slice(0, l)) ?? []) {
					const r = ruleAt(a, ref);
					visit(st, strip(r) + s.slice(l), ref, r);
				}
			}
		}
		frontier = next;
	}
	return allowed;
}

/**
 * The type of a declared affix class. A flag with no class reads as a prefix,
 * the zero value Go's map lookup hands back; every flag reached from the
 * index has a class, so this only settles what the comparison means.
 */
function affixType(a: DictConfig, flag: string): AffixType {
	return a.affixMap.get(flag)?.type ?? "prefix";
}

function ruleAt(a: DictConfig, ref: AffixRef): Rule {
	const af = a.affixMap.get(ref.flag);
	return (af as { rules: Rule[] }).rules[ref.idx] as Rule;
}

/**
 * What the producer of a rule's base must carry, once the rule is taken off a
 * string whose producer had to carry `needs`: the rule may share the level
 * with those affixes, or its continuation may have opened their level.
 */
function nextNeeds(a: DictConfig, needs: string, ref: AffixRef, r: Rule): string[] {
	if (needs === "") return [ref.flag];

	const out: string[] = [];
	const held = needs.split("\u0000");
	if (
		held.length === 1 &&
		affixType(a, held[0] as string) !== affixType(a, ref.flag)
	) {
		// Same level: a prefix beside a suffix.
		out.push(`${ref.flag}\u0000${held[0]}`);
	}
	if (r.cont !== "") {
		const cont = a.parseFlags(r.cont);
		let opened = true;
		for (const h of held) {
			if (!cont.includes(h)) {
				opened = false;
				break;
			}
		}
		if (opened) out.push(ref.flag);
	}
	return out;
}

/** What `readings` needs of the speller that owns the roots. */
export interface Analyzer {
	readonly affix: DictConfig;
	/**
	 * The upper-cased form of each root with a capital, mapped to the roots it
	 * stands for -- Hunspell's hidden upper-case homonym.
	 */
	readonly upperRoots: Map<string, string[]>;
	upperKey(word: string): string;
}

/**
 * Every reading of `word` as a root plus affixes, with the flags each reading
 * carries.
 *
 * With `fold`, `word` is all-caps and matches the upper-cased form of any
 * reading.
 */
export function readings(
	s: Analyzer,
	word: string,
	fold: boolean,
	roots: Map<string, RootEntry[]>,
): EntryForm[] {
	const allowed = reverseSet(s.affix, word, fold);

	const key = fold ? (w: string) => s.upperKey(w) : (w: string) => w;
	const rootsOf = fold
		? (cand: string): string[] => {
				const found: string[] = [];
				for (const root of s.upperRoots.get(cand) ?? []) {
					if (roots.has(root)) found.push(root);
				}
				return found;
			}
		: (cand: string): string[] => (roots.has(cand) ? [cand] : []);

	const e = s.affix.expander(allowed, key);
	const out: EntryForm[] = [];
	for (const cand of allowed) {
		for (const root of rootsOf(cand)) {
			for (const entry of roots.get(root) as RootEntry[]) {
				for (const f of e.root(root, entry.flags)) {
					if (key(f.word) === word) out.push(f);
				}
			}
		}
	}
	return out;
}
