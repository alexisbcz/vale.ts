/**
 * The character sets where the dialects disagree.
 *
 * `regexp2` in RE2 mode reads `\d` and `\w` as ASCII, exactly as JavaScript
 * does, so those pass through. `\s` and the word boundary do not: `\s` is
 * RE2's five characters rather than JavaScript's Unicode whitespace, and `\b`
 * is .NET's, which treats any letter as a word character where JavaScript's
 * treats only ASCII ones as such.
 */

/**
 * RE2's `\s`: horizontal tab, newline, form feed, carriage return and space.
 *
 * Note the omission of the vertical tab, which JavaScript's `\s` includes --
 * as do Perl and .NET. Go's `regexp` leaves it out, and the RE2 option follows
 * Go.
 */
export const RE2_SPACE = "\\t\\n\\f\\r ";

/**
 * The characters .NET's `\b` counts as part of a word: `\p{L}`, `\p{Mn}`,
 * `\p{Nd}`, `\p{Pc}`, and the two joiners.
 *
 * Spelled as a character-class body so it can be dropped into a lookaround.
 */
export const WORD_CHARS = "\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}\\u200c\\u200d";

/** `\b`, as a pair of lookarounds JavaScript understands. */
export const WORD_BOUNDARY = `(?:(?<=[${WORD_CHARS}])(?![${WORD_CHARS}])|(?<![${WORD_CHARS}])(?=[${WORD_CHARS}]))`;

/** `\B`. */
export const NON_WORD_BOUNDARY = `(?:(?<=[${WORD_CHARS}])(?=[${WORD_CHARS}])|(?<![${WORD_CHARS}])(?![${WORD_CHARS}]))`;

/**
 * The POSIX bracket expressions RE2 accepts, as ASCII ranges.
 *
 * RE2 defines these over ASCII only, so `[[:alpha:]]` does not match `é` --
 * which is why they are expanded here rather than mapped onto `\p{...}`.
 */
export const POSIX_CLASSES: Record<string, string> = {
	alnum: "0-9A-Za-z",
	alpha: "A-Za-z",
	ascii: "\\x00-\\x7f",
	blank: "\\t ",
	cntrl: "\\x00-\\x1f\\x7f",
	digit: "0-9",
	graph: "!-~",
	lower: "a-z",
	print: " -~",
	punct: "!-/:-@\\[-`\\{-~",
	space: "\\t\\n\\v\\f\\r ",
	upper: "A-Z",
	word: "0-9A-Za-z_",
	xdigit: "0-9A-Fa-f",
};

/** The Unicode general-category codes `\p{...}` may name directly. */
const GENERAL_CATEGORIES = new Set([
	"C",
	"Cc",
	"Cf",
	"Cn",
	"Co",
	"Cs",
	"L",
	"LC",
	"Ll",
	"Lm",
	"Lo",
	"Lt",
	"Lu",
	"M",
	"Mc",
	"Me",
	"Mn",
	"N",
	"Nd",
	"Nl",
	"No",
	"P",
	"Pc",
	"Pd",
	"Pe",
	"Pf",
	"Pi",
	"Po",
	"Ps",
	"S",
	"Sc",
	"Sk",
	"Sm",
	"So",
	"Z",
	"Zl",
	"Zp",
	"Zs",
]);

/**
 * Binary properties JavaScript exposes by name. A property Go spells the same
 * way needs no translation.
 */
const BINARY_PROPERTIES = new Set([
	"ASCII",
	"ASCII_Hex_Digit",
	"AHex",
	"Alphabetic",
	"Alpha",
	"Any",
	"Assigned",
	"Bidi_Control",
	"Bidi_C",
	"Bidi_Mirrored",
	"Bidi_M",
	"Case_Ignorable",
	"CI",
	"Cased",
	"Changes_When_Casefolded",
	"CWCF",
	"Changes_When_Casemapped",
	"CWCM",
	"Changes_When_Lowercased",
	"CWL",
	"Changes_When_NFKC_Casefolded",
	"CWKCF",
	"Changes_When_Titlecased",
	"CWT",
	"Changes_When_Uppercased",
	"CWU",
	"Dash",
	"Default_Ignorable_Code_Point",
	"DI",
	"Deprecated",
	"Dep",
	"Diacritic",
	"Dia",
	"Emoji",
	"Emoji_Component",
	"EComp",
	"Emoji_Modifier",
	"EMod",
	"Emoji_Modifier_Base",
	"EBase",
	"Emoji_Presentation",
	"EPres",
	"Extended_Pictographic",
	"ExtPict",
	"Extender",
	"Ext",
	"Grapheme_Base",
	"Gr_Base",
	"Grapheme_Extend",
	"Gr_Ext",
	"Hex_Digit",
	"Hex",
	"IDS_Binary_Operator",
	"IDSB",
	"IDS_Trinary_Operator",
	"IDST",
	"ID_Continue",
	"IDC",
	"ID_Start",
	"IDS",
	"Ideographic",
	"Ideo",
	"Join_Control",
	"Join_C",
	"Logical_Order_Exception",
	"LOE",
	"Lowercase",
	"Lower",
	"Math",
	"Noncharacter_Code_Point",
	"NChar",
	"Pattern_Syntax",
	"Pat_Syn",
	"Pattern_White_Space",
	"Pat_WS",
	"Quotation_Mark",
	"QMark",
	"Radical",
	"Regional_Indicator",
	"RI",
	"Sentence_Terminal",
	"STerm",
	"Soft_Dotted",
	"SD",
	"Terminal_Punctuation",
	"Term",
	"Unified_Ideograph",
	"UIdeo",
	"Uppercase",
	"Upper",
	"Variation_Selector",
	"VS",
	"White_Space",
	"space",
	"XID_Continue",
	"XIDC",
	"XID_Start",
	"XIDS",
]);

/** Property names JavaScript takes a value for. */
const VALUED_PROPERTIES: Record<string, string> = {
	gc: "General_Category",
	general_category: "General_Category",
	sc: "Script",
	script: "Script",
	scx: "Script_Extensions",
	script_extensions: "Script_Extensions",
};

const probeCache = new Map<string, boolean>();

/** Reports whether `RegExp` accepts the given `\p{...}` body. */
function probe(body: string): boolean {
	const cached = probeCache.get(body);
	if (cached !== undefined) return cached;
	let ok = true;
	try {
		new RegExp(`\\p{${body}}`, "u");
	} catch {
		ok = false;
	}
	probeCache.set(body, ok);
	return ok;
}

/**
 * Translates a `\p{...}` class name onto one JavaScript understands.
 *
 * Go names a general category, a script, or one of the properties its Unicode
 * tables expose, and `regexp2`'s fork adds the `property=value` form. Scripts
 * are the case that needs translating: Go writes `\p{Greek}` where JavaScript
 * wants `\p{Script=Greek}`.
 *
 * Returns null when nothing recognizes the name, which leaves the caller to
 * reject the pattern rather than compile one that matches something else.
 */
export function translateProperty(name: string): string | null {
	const trimmed = name.trim();

	if (trimmed.includes("=")) {
		const [rawProp = "", rawValue = ""] = trimmed.split("=", 2);
		const key = rawProp
			.trim()
			.toLowerCase()
			.replace(/[\s_-]/g, "_");
		const prop = VALUED_PROPERTIES[key] ?? VALUED_PROPERTIES[key.replace(/_/g, "")];
		const value = rawValue.trim().replace(/[\s-]/g, "_");
		if (prop && probe(`${prop}=${value}`)) return `${prop}=${value}`;
		return null;
	}

	if (GENERAL_CATEGORIES.has(trimmed)) return trimmed;
	if (BINARY_PROPERTIES.has(trimmed) && probe(trimmed)) return trimmed;

	// Go's `Any` covers every code point, which JavaScript spells differently.
	if (trimmed === "Any") return "Any";

	const scriptish = trimmed.replace(/[\s-]/g, "_");
	if (probe(`Script=${scriptish}`)) return `Script=${scriptish}`;
	if (probe(`Script_Extensions=${scriptish}`)) {
		return `Script_Extensions=${scriptish}`;
	}
	if (probe(scriptish)) return scriptish;

	return null;
}
