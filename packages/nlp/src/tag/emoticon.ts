/**
 * The emoticon set shared by prose's tokenizer and tagger.
 *
 * It lives here so the two cannot drift apart: the tagger tags anything in
 * this set as `SYM`, and the tokenizer must agree on what counts as one token.
 */

/** Every known emoticon. Read-only. */
export const emoticonSet: ReadonlySet<string> = new Set([
	"(-8",
	"(-;",
	"(-_-)",
	"(._.)",
	"(:",
	"(=",
	"(o:",
	"(¬_¬)",
	"(ಠ_ಠ)",
	"(╯°□°）╯︵┻━┻",
	"-__-",
	"8-)",
	"8-D",
	"8D",
	":(",
	":((",
	":(((",
	":()",
	":)))",
	":-)",
	":-))",
	":-)))",
	":-*",
	":-/",
	":-X",
	":-]",
	":-o",
	":-p",
	":-x",
	":-|",
	":-}",
	":0",
	":3",
	":P",
	":]",
	":`(",
	":`)",
	":`-(",
	":o",
	":o)",
	"=(",
	"=)",
	"=D",
	"=|",
	"@_@",
	"O.o",
	"O_o",
	"V_V",
	"XDD",
	"[-:",
	"^___^",
	"o_0",
	"o_O",
	"o_o",
	"v_v",
	"xD",
	"xDD",
	"¯\\(ツ)/¯",
]);

/** Whether `s` is a known emoticon. */
export function isEmoticon(s: string): boolean {
	return emoticonSet.has(s);
}
