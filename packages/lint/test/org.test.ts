/**
 * What the Org converter makes of each construct.
 *
 * Go hands the document to `niklasfasching/go-org`, whose own tests cover the
 * language; there is no equivalent in `internal/lint/org_test.go`. These cases
 * pin what this port's converter covers instead -- the shapes Vale's Org
 * fixtures hold, and the inline rules that keep arithmetic from being read as
 * emphasis.
 */

import { describe, expect, test } from "bun:test";
import { inline, orgToHTML } from "../src/org.ts";

interface Case {
	name: string;
	in: string;
	want?: string[];
	absent?: string[];
}

const cases: Case[] = [
	{
		name: "a prose keyword is written where the source has it",
		in: "#+title:  Example Org File\n#+author: TEC\n\nSome prose.\n",
		want: [
			'<h1 class="title">Example Org File</h1>',
			'<p class="author">TEC</p>',
			"<p>Some prose.</p>",
		],
	},
	{
		name: "headlines are headings of their own depth",
		in: "* Revamp the website\n\n** Make screenshots\n",
		want: ["<h1>Revamp the website</h1>", "<h2>Make screenshots</h2>"],
	},
	{
		name: "a TODO keyword is state, not prose",
		in: "** DONE Make screenshots\n",
		want: ['<span class="todo">DONE</span>', "Make screenshots"],
	},
	{
		name: "a priority cookie is state",
		in: "* [#A] Do the thing\n",
		want: ['<span class="priority">A</span>', "Do the thing"],
	},
	{
		name: "a planning line is markup",
		in: "** DONE Restyle the CSS\n   CLOSED: [2020-09-03 Thu 18:24]\n\nProse here.\n",
		want: ["<p>Prose here.</p>"],
		absent: ["CLOSED", "18:24"],
	},
	{
		name: "a properties drawer is markup",
		in: "* Heading\n:PROPERTIES:\n:ID: abc\n:END:\n\nProse here.\n",
		want: ["<p>Prose here.</p>"],
		absent: ["PROPERTIES", "abc"],
	},
	{
		name: "a source block is literal",
		in: "#+begin_src python\nimport volto\n#+end_src\n\nProse here.\n",
		want: ["<pre>import volto</pre>", "<p>Prose here.</p>"],
		absent: ["<p>import"],
	},
	{
		name: "a quote block is prose",
		in: "#+begin_quote\nQuoted prose.\n#+end_quote\n",
		want: ["<blockquote>", "<p>Quoted prose.</p>", "</blockquote>"],
	},
	{
		name: "a comment reaches the walker as an HTML comment",
		in: "# vale off\n\nProse here.\n",
		want: ["<!-- vale off -->", "<p>Prose here.</p>"],
	},
	{
		name: "emphasis, verbatim and code",
		in: "The /beauty/ of org *must* be shared, and =TODO= is ~code~.\n",
		want: [
			"<em>beauty</em>",
			"<strong>must</strong>",
			"<code>TODO</code>",
			"<code>code</code>",
		],
	},
	{
		// The target lives in the `href`, which the walker reads no text from.
		name: "a link keeps its description, not its target",
		in: "Go through [[file:style.scss][stylesheet]].\n",
		want: [">stylesheet</a>"],
		absent: [">file:style.scss<"],
	},
	{
		name: "a bare link contributes no text",
		in: "[[https://upload.wikimedia.org/Share_Icon.svg]]\n",
		want: ['<a href="https://upload.wikimedia.org/Share_Icon.svg"></a>'],
	},
	{
		name: "a table's rule row makes a header",
		in: "| index.css | 76% minified |\n|-----------+--------------|\n| org.css   | 75% minified |\n",
		// The rows above the rule are the header.
		want: ["<table>", "<th>index.css</th>", "<td>org.css</td>"],
	},
	{
		name: "a plain list becomes a list",
		in: "- one item\n- two items\n",
		want: ["<ul>", "<li>", "one item", "two items", "</ul>"],
	},
	{
		name: "an ordered list becomes an ordered list",
		in: "1. one item\n2. two items\n",
		want: ["<ol>", "one item", "</ol>"],
	},
	{
		name: "a description list's term is emphasized",
		in: "- term :: the description\n",
		want: ["<strong>term</strong>", "the description"],
	},
	{
		name: "a footnote definition is written where the source has it",
		in: "[fn:1] The footnote's prose.\n\nProse after it.\n",
		want: ['<div class="footnote-definition">', "The footnote's prose."],
	},
	{
		name: "an inline footnote keeps its text, a reference says nothing",
		in: "A claim[fn:1] and another[fn::the aside].\n",
		want: ["the aside"],
		absent: ["fn:1"],
	},
	{
		name: "a horizontal rule",
		in: "Before.\n\n-----\n\nAfter.\n",
		want: ["<hr>"],
	},
	{
		name: "a timestamp is a date, not prose",
		in: "Scheduled <2020-10-27 Tue> for release.\n",
		want: ["Scheduled", "for release."],
		absent: ["2020-10-27", "Tue"],
	},
];

describe("the Org converter", () => {
	for (const c of cases) {
		test(c.name, () => {
			const html = orgToHTML(c.in);
			for (const want of c.want ?? []) expect(html).toContain(want);
			for (const absent of c.absent ?? []) expect(html).not.toContain(absent);
		});
	}
});

/**
 * Org's rule for emphasis is a five-part pattern: what precedes the marker,
 * the marker, a body that neither begins nor ends with whitespace, the marker
 * again, and what follows it. Without it, `5 * 3 and 2 * 4` is one bold span
 * and the arithmetic disappears from the document.
 */
describe("the inline rules", () => {
	test("arithmetic is not emphasis", () => {
		expect(inline("5 * 3 and 2 * 4")).toBe("5 * 3 and 2 * 4");
	});

	test("a marker against whitespace opens nothing", () => {
		expect(inline("a * b* c")).toBe("a * b* c");
	});

	test("a marker mid-word opens nothing", () => {
		expect(inline("snake_case_name")).toBe("snake_case_name");
	});

	test("markup inside emphasis is read", () => {
		expect(inline("*bold with /italic/ inside*")).toBe(
			"<strong>bold with <em>italic</em> inside</strong>",
		);
	});

	test("verbatim holds no markup", () => {
		expect(inline("=a /b/ c=")).toBe("<code>a /b/ c</code>");
	});

	test("markup in prose is escaped", () => {
		expect(inline("a <script> tag")).toBe("a &lt;script&gt; tag");
	});
});
