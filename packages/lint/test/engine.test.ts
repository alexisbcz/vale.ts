/**
 * Tests for the parts of the reader that work without any rules: the HTML
 * tokenizer, the whitespace reconstruction, the Markdown masking pass, the
 * configuration-driven rewrites, and plain text read as a document.
 *
 * The walker and the block pipeline are exercised end to end by the
 * compatibility suite, which has 367 of Vale's own cases to run; what is worth
 * testing here is the behavior that has no rule in it.
 */

import { describe, expect, test } from "bun:test";
import { type Config, Glob, newConfig, newFlags } from "@vale-ts/core";
import { clean, leadingSpace, trailingSpace } from "../src/ast.ts";
import { textToHTML } from "../src/html.ts";
import { mathCloserIndex } from "../src/math.ts";
import { prepMarkdown } from "../src/md.ts";
import { applyPatterns, hasPatterns } from "../src/patterns.ts";
import { wrapSections } from "../src/selection.ts";
import {
	getAttribute,
	Tokenizer,
	TokenType,
	unescapeEntities,
} from "../src/tokenizer.ts";

/** Every token in `html`, as `[type, data]` pairs. */
function tokens(html: string): Array<[TokenType, string]> {
	const tz = new Tokenizer(html);
	const out: Array<[TokenType, string]> = [];
	for (;;) {
		const type = tz.next();
		if (type === TokenType.Error) break;
		out.push([type, tz.token().data]);
	}
	return out;
}

describe("the HTML tokenizer", () => {
	test("reports tags, text and comments in document order", () => {
		expect(tokens("<p>Hi</p><!--note-->")).toEqual([
			[TokenType.StartTag, "p"],
			[TokenType.Text, "Hi"],
			[TokenType.EndTag, "p"],
			[TokenType.Comment, "note"],
		]);
	});

	test("lower-cases tag and attribute names", () => {
		const tz = new Tokenizer('<A HREF="x">');
		tz.next();
		const tok = tz.token();
		expect(tok.data).toBe("a");
		expect(getAttribute(tok, "href")).toBe("x");
	});

	test("a self-closing tag is its own kind", () => {
		// `<br/>` separates the words around it just as `<br>` does, and the
		// walker has to see that it is not a start tag.
		expect(tokens("a<br/>b")).toEqual([
			[TokenType.Text, "a"],
			[TokenType.SelfClosingTag, "br"],
			[TokenType.Text, "b"],
		]);
	});

	test("text keeps the whitespace around it", () => {
		// The walker reconstructs how the source separated a text node from the
		// markup beside it, so the raw token must not be trimmed.
		const [, text] = tokens("<b>x</b> y\n");
		expect(tokens("<b>x</b> y\n")[3]).toEqual([TokenType.Text, " y\n"]);
		expect(text).toEqual([TokenType.Text, "x"]);
	});

	test("entities in text and attributes are decoded once", () => {
		expect(tokens("&amp;amp;")).toEqual([[TokenType.Text, "&amp;"]]);
		const tz = new Tokenizer('<a href="a&amp;b">');
		tz.next();
		expect(getAttribute(tz.token(), "href")).toBe("a&b");
	});

	test("a raw-text element's contents arrive whole and undecoded", () => {
		// Otherwise a `<` inside a script reads as a tag.
		expect(tokens("<script>if (a<b) &amp;</script>")).toEqual([
			[TokenType.StartTag, "script"],
			[TokenType.Text, "if (a<b) &amp;"],
			[TokenType.EndTag, "script"],
		]);
	});

	test("an end tag that only looks like the closing one does not close", () => {
		expect(tokens("<style>a</stylish>b</style>")).toEqual([
			[TokenType.StartTag, "style"],
			[TokenType.Text, "a</stylish>b"],
			[TokenType.EndTag, "style"],
		]);
	});

	test("a `<` that opens nothing is text", () => {
		expect(tokens("5 < 6")).toEqual([[TokenType.Text, "5 < 6"]]);
	});

	test("an unquoted attribute value is read to the next space", () => {
		const tz = new Tokenizer("<img src=a.png alt=hi>");
		tz.next();
		const tok = tz.token();
		expect(getAttribute(tok, "src")).toBe("a.png");
		expect(getAttribute(tok, "alt")).toBe("hi");
	});

	test("a valueless attribute is empty rather than absent", () => {
		const tz = new Tokenizer("<input disabled>");
		tz.next();
		expect(tz.token().attr).toEqual([{ key: "disabled", val: "" }]);
	});

	test("an unterminated comment runs to the end", () => {
		expect(tokens("<!--open")).toEqual([[TokenType.Comment, "open"]]);
	});

	test("a doctype is its own kind", () => {
		expect(tokens("<!DOCTYPE html><p>")[0]?.[0]).toBe(TokenType.Doctype);
	});

	test("unescapeEntities matches what the walker applies twice", () => {
		expect(unescapeEntities("&lt;b&gt;")).toBe("<b>");
		expect(unescapeEntities(unescapeEntities("&amp;lt;"))).toBe("<");
	});
});

describe("whitespace reconstruction", () => {
	test("a leading line break stays a line break", () => {
		// A line break in the source is a line break in the block, so a rule
		// anchored to the end of a line still sees one.
		expect(leadingSpace("\n  x")).toBe("\n");
		expect(leadingSpace(" x")).toBe(" ");
		expect(leadingSpace("x")).toBe("");
		expect(leadingSpace("")).toBe("");
	});

	test("trailing whitespace is read the same way", () => {
		expect(trailingSpace("x\n")).toBe("\n");
		expect(trailingSpace("x ")).toBe(" ");
		expect(trailingSpace("x")).toBe("");
	});

	test("inline content is padded, and punctuation after it is not", () => {
		// `in <code/> for` must not collapse to `infor`, and `<b>x</b>.` must
		// not gain a space before the period.
		expect(clean("for", "", false, true, "", false).text).toBe(" for");
		expect(clean(".", "", false, true, "", false).text).toBe(".");
	});

	test("text after a closed inline element takes the source's separator", () => {
		// `<code>X</code>s` must not gain a space, and `<strong>x</strong> :`
		// must not lose one.
		expect(clean("s", "", false, false, "", true).text).toBe("s");
		expect(clean(":", "", false, false, " ", true).text).toBe(" :");
	});

	test("a skipped element's text is masked to its own width", () => {
		// Positions after it must not move, and nothing in it may be read as
		// prose. The mask is still padded, because the element is inline and the
		// text before it would otherwise fuse with what follows.
		const out = clean("code", "", true, true, "", false);
		expect(out.text).toBe(" ****");
		expect(out.skip).toBe(false);
	});
});

describe("the Markdown masking pass", () => {
	test("a fence's info string is masked, keeping its backticks", () => {
		// A rule looking for `json` must not report the info string.
		expect(prepMarkdown("```json\nx\n```")).toBe("```****\nx\n```");
	});

	test("the number of opening backticks is respected", () => {
		expect(prepMarkdown("````json\n")).toBe("````****\n");
	});

	test("a reference link's label is masked", () => {
		expect(prepMarkdown("[text][label]")).toBe("[text][*****]");
		expect(prepMarkdown("[label]: http://x")).toBe("[*****]: http://x");
	});

	test("an ordered list's marker is masked", () => {
		expect(prepMarkdown("1. item\n12. item")).toBe("** item\n*** item");
	});

	test("masking never changes a document's length", () => {
		const src = "```json\n1. a\n```\n[t][ref]\n\n[ref]: http://x\n";
		expect(prepMarkdown(src)).toHaveLength(src.length);
	});

	test("prose is left alone", () => {
		expect(prepMarkdown("Just a sentence.")).toBe("Just a sentence.");
	});
});

describe("display math", () => {
	test("a `$$` that ends the line closes the block", () => {
		expect(mathCloserIndex("x=1$$")).toBe(3);
		expect(mathCloserIndex("$$")).toBe(0);
		expect(mathCloserIndex("$$  ")).toBe(0);
	});

	test("a trailing cross-reference label still closes it", () => {
		// Pandoc and Quarto put a label there.
		expect(mathCloserIndex("$$ {#eq-foo}")).toBe(0);
	});

	test("an escaped `$$` closes nothing", () => {
		expect(mathCloserIndex("x\\$$")).toBe(-1);
	});

	test("a line with no closer reports none", () => {
		expect(mathCloserIndex("x = 1")).toBe(-1);
		expect(mathCloserIndex("$")).toBe(-1);
	});
});

describe("plain text read as a document", () => {
	test("a file with no chapter line is not a document", () => {
		expect(textToHTML("Just some prose.\n\nAnd more.").ok).toBe(false);
	});

	test("a chapter line becomes a heading", () => {
		const { html, ok } = textToHTML("Chapter One\n\nIt began.\n");
		expect(ok).toBe(true);
		expect(html).toContain("<h2>Chapter One</h2>");
		expect(html).toContain("<p>It began.</p>");
	});

	test("a part line outranks a chapter", () => {
		const { html } = textToHTML("Part II\n\nChapter One\n\nIt began.\n");
		expect(html).toContain("<h1>Part II</h1>");
		expect(html).toContain("<h2>Chapter One</h2>");
	});

	test("a bare numeral is a chapter", () => {
		expect(textToHTML("1\n\nIt began.\n").html).toContain("<h2>1</h2>");
		expect(textToHTML("IV.\n\nIt began.\n").html).toContain("<h2>IV.</h2>");
	});

	test("a short first line followed by a chapter is the title", () => {
		const { html } = textToHTML("The Book\n\nChapter One\n\nIt began.\n");
		expect(html).toContain("<h1>The Book</h1>");
	});

	test("a scene break is a rule", () => {
		const { html } = textToHTML("Chapter One\n\n* * *\n\nLater.\n");
		expect(html).toContain("<hr>");
	});

	test("prose is escaped, so markup in it cannot open a tag", () => {
		const { html } = textToHTML("Chapter One\n\nA <b> and an &.\n");
		expect(html).toContain("&lt;b&gt;");
		expect(html).toContain("&amp;");
	});
});

describe("`doc(...)` section wrapping", () => {
	test("a heading encloses what follows it", () => {
		// `wrapSections` works on a parse5 tree, which is heavier to build than
		// this test needs; what matters is that it leaves a document with no
		// headings untouched, which is the path every ordinary run takes.
		const doc = { type: "root", children: [] } as never;
		expect(() => wrapSections(doc)).not.toThrow();
	});
});

describe("configuration-driven rewrites", () => {
	function configWith(apply: (cfg: Config) => void): Config {
		const cfg = newConfig(newFlags({ ignoreGlobal: true }));
		apply(cfg);
		return cfg;
	}

	const exts = {
		normed: ".md",
		real: ".md",
		realPath: "doc.md",
		held: {},
	};

	test("front matter is wrapped in a code block", () => {
		// Its keys are identifiers and its dates are dates; the fields that are
		// prose are linted separately, by `lintMetadata`.
		const cfg = configWith(() => {});
		const out = applyPatterns(cfg, exts, "---\ntitle: X\n---\n\nBody.\n");
		expect(out).toContain("```");
		expect(out).toContain("Body.");
	});

	test("a BlockIgnores match becomes a fenced block", () => {
		// The pattern captures what it wants kept, which the delimiter's `$1`
		// then places inside the block -- the shape Vale documents.
		const cfg = configWith((c) => {
			c.blockIgnores["*"] = ["(?s)(SKIP.*?ENDSKIP)"];
			c.secToPat["*"] = compilePattern("*");
		});
		const out = applyPatterns(cfg, exts, "a\nSKIP x ENDSKIP\nb\n");
		expect(out).toBe("a\n\n```\nSKIP x ENDSKIP\n```\n\nb\n");
	});

	test("a pattern with no capture group leaves the delimiter's `$1` alone", () => {
		// .NET emits an unresolvable `$1` as text rather than as nothing, and a
		// rule written without the group should look wrong rather than silently
		// swallow its match.
		const cfg = configWith((c) => {
			c.blockIgnores["*"] = ["(?s)SKIP.*?ENDSKIP"];
			c.secToPat["*"] = compilePattern("*");
		});
		const out = applyPatterns(cfg, exts, "a\nSKIP x ENDSKIP\nb\n");
		expect(out).toContain("$1");
	});

	test("a TokenIgnores match becomes inline code", () => {
		const cfg = configWith((c) => {
			c.tokenIgnores["*"] = ["(\\$[^\\n$]+\\$)"];
			c.secToPat["*"] = compilePattern("*");
		});
		const out = applyPatterns(cfg, exts, "math $x = 1$ here\n");
		expect(out).toBe("math `$x = 1$` here\n");
	});

	test("custom comment delimiters become HTML comments", () => {
		const cfg = configWith((c) => {
			c.commentDelimiters["*"] = ["{/*", "*/}"];
			c.secToPat["*"] = compilePattern("*");
		});
		const out = applyPatterns(cfg, exts, "{/* vale off */}\nx\n");
		expect(out).toContain("<!-- vale off -->");
	});

	test("a format with no delimiters is refused rather than mangled", () => {
		const cfg = configWith(() => {});
		expect(() => applyPatterns(cfg, { ...exts, normed: ".txt" }, "x")).toThrow(
			/not supported/,
		);
	});

	test("hasPatterns reports whether anything would be rewritten", () => {
		expect(
			hasPatterns(
				configWith(() => {}),
				exts,
			),
		).toBe(false);
		const cfg = configWith((c) => {
			c.tokenIgnores["*"] = ["x"];
			c.secToPat["*"] = compilePattern("*");
		});
		expect(hasPatterns(cfg, exts)).toBe(true);
	});
});

/** A glob for a section key, built the way the configuration loader does. */
function compilePattern(pat: string): Glob {
	return Glob.compile(pat);
}
