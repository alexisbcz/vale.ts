/**
 * Counting syllables, which three of the readability scores need.
 *
 * The method is a pile of English spelling rules rather than a dictionary: a
 * table of corner cases, then affixes stripped off the ends, then vowel groups
 * counted and adjusted by patterns that add or remove a syllable. It is
 * approximate by design -- the scores it feeds are themselves approximations.
 */

import { strLen } from "../util.ts";

/** How many matches `re` has in `s`. Every pattern here is global. */
function count(s: string, re: RegExp): number {
	return (s.match(re) ?? []).length;
}

/**
 * The number of syllables in `word`.
 *
 * NOTE: this expects a word, not raw text.
 */
export function syllables(word: string): number {
	// See if we can leave early ...
	const length = strLen(word);
	if (length < 1) return 0;
	if (length < 3) return 1;

	// See if this is a known corner case ...
	const lower = word.toLowerCase();
	const known = cornercases.get(lower);
	if (known !== undefined) return known;

	const [text, cleaned] = clean(lower);
	let n = cleaned;

	// Count multiple vowels.
	n += count(text, vowels);

	n -= count(text, monosyllabicOne);
	n -= count(text, monosyllabicTwo);

	n += count(text, doubleSyllabicOne);
	n += count(text, doubleSyllabicTwo);
	n += count(text, doubleSyllabicThree);
	n += count(text, doubleSyllabicFour);

	if (n < 1) return 1;
	return n;
}

function clean(word: string): [string, number] {
	const [afterPrefix, prefix] = clearPart(word, incrementToPrefix, trimAnyPrefix);
	const [afterSuffix, suffix] = clearPart(
		afterPrefix,
		incrementToSuffix,
		trimAnySuffix,
	);
	return [afterSuffix, prefix + suffix];
}

type ClearFunc = (word: string, affixes: readonly string[]) => string;

/**
 * Strips the first affix group that matches, reporting how many syllables that
 * group is worth.
 *
 * The groups are ordered longest-affix first and the count runs down from the
 * group count, so a word ending in `-ology` scores more than one ending in
 * `-ly`.
 */
function clearPart(
	s: string,
	options: ReadonlyArray<readonly string[]>,
	clearer: ClearFunc,
): [string, number] {
	const old = s;
	const pos = options.length;
	let cur = s;
	for (let i = 0; i < options.length; i++) {
		cur = clearer(cur, options[i]!);
		if (cur !== old) return [cur, pos - i];
	}
	return [cur, 0];
}

function trimAnySuffix(word: string, suffixes: readonly string[]): string {
	for (const suffix of suffixes) {
		if (word.endsWith(suffix)) return word.slice(0, word.length - suffix.length);
	}
	return word;
}

function trimAnyPrefix(word: string, prefixes: readonly string[]): string {
	for (const prefix of prefixes) {
		if (word.startsWith(prefix)) return word.slice(prefix.length);
	}
	return word;
}

const cornercases = new Map<string, number>([
	["abalone", 4],
	["abare", 3],
	["abed", 2],
	["abruzzese", 4],
	["abbruzzese", 4],
	["aborigine", 5],
	["aborigines", 5],
	["acreage", 3],
	["adame", 3],
	["adieu", 2],
	["adobe", 3],
	["anemone", 4],
	["apache", 3],
	["aphrodite", 4],
	["apostrophe", 4],
	["ariadne", 4],
	["cafe", 2],
	["cafes", 2],
	["calliope", 4],
	["catastrophe", 4],
	["chile", 2],
	["chloe", 2],
	["circe", 2],
	["coyote", 3],
	["epitome", 4],
	["facsimile", 4],
	["forever", 3],
	["gethsemane", 4],
	["guacamole", 4],
	["hyperbole", 4],
	["jesse", 2],
	["jukebox", 2],
	["karate", 3],
	["machete", 3],
	["maybe", 2],
	["people", 2],
	["recipe", 3],
	["sesame", 3],
	["shoreline", 2],
	["simile", 3],
	["syncope", 3],
	["tamale", 3],
	["yosemite", 4],
	["daphne", 2],
	["eurydice", 4],
	["euterpe", 3],
	["hermione", 4],
	["penelope", 4],
	["persephone", 4],
	["phoebe", 2],
	["zoe", 2],
]);

const monosyllabicOne =
	/cia(l|$)|tia|cius|cious|[^aeiou]giu|[aeiouy][^aeiouy]ion|iou|sia$|eous$|[oa]gue$|.[^aeiuoycgltdb]{2,}ed$|.ely$|^jua|uai|eau|^busi$|([aeiouy](b|c|ch|dg|f|g|gh|gn|k|l|lch|ll|lv|m|mm|n|nc|ng|nch|nn|p|r|rc|rn|rs|rv|s|sc|sk|sl|squ|ss|th|v|y|z)ed$)|([aeiouy](b|ch|d|f|gh|gn|k|l|lch|ll|lv|m|mm|n|nch|nn|p|r|rn|rs|rv|s|sc|sk|sl|squ|ss|st|t|th|v|y)es$)/g;

const monosyllabicTwo =
	/[aeiouy](b|c|ch|d|dg|f|g|gh|gn|k|l|ll|lv|m|mm|n|nc|ng|nn|p|r|rc|rn|rs|rv|s|sc|sk|sl|squ|ss|st|t|th|v|y|z)e$/g;

const doubleSyllabicOne =
	/(?:[^aeiouy]ie(r|st|t)|[aeiouym]bl|eo|ism|asm|thm|dnt|uity|dea|gean|oa|ua|eings?|[aeiouy]sh?e[rsd])$/g;

const doubleSyllabicTwo = /[^gq]ua[^auieo]|[aeiou]{3}|^(ia|mc|coa[dglx].)/g;

const doubleSyllabicThree =
	/[^aeiou]y[ae]|[^l]lien|riet|dien|iu|io|ii|uen|real|iell|eo[^aeiou]|[aeiou]y[aeiou]/g;

const doubleSyllabicFour = /[^s]ia/g;

const vowels = /[aeiouy]+/g;

const incrementToPrefix: ReadonlyArray<readonly string[]> = [
	[
		"above",
		"anti",
		"ante",
		"counter",
		"hyper",
		"afore",
		"agri",
		"infra",
		"intra",
		"inter",
		"over",
		"semi",
		"ultra",
		"under",
		"extra",
		"dia",
		"micro",
		"mega",
		"kilo",
		"pico",
		"nano",
		"macro",
	],
	[
		"un",
		"fore",
		"ware",
		"none",
		"non",
		"out",
		"post",
		"sub",
		"pre",
		"pro",
		"dis",
		"side",
	],
];

const incrementToSuffix: ReadonlyArray<readonly string[]> = [
	["ology", "ologist", "onomy", "onomist"],
	["fully", "berry", "woman", "women"],
	[
		"ly",
		"less",
		"some",
		"ful",
		"er",
		"ers",
		"ness",
		"cian",
		"cians",
		"ment",
		"ments",
		"ette",
		"ettes",
		"ville",
		"villes",
		"ships",
		"ship",
		"side",
		"sides",
		"port",
		"ports",
		"shire",
		"shires",
		"tion",
		"tioned",
	],
];
