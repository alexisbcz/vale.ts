/**
 * What the MyST reader makes of each construct.
 *
 * Ported from `internal/lint/myst_test.go`. Prose directives become classed
 * divs the walker lints (and scopes), literal directives become skipped
 * `<pre>` blocks, and pure markup -- targets, roles, comments, options --
 * renders as nothing at all.
 */

import { describe, expect, test } from "bun:test";
import { newConfig, newFlags } from "@vale-ts/core";
import { newMyST } from "../src/myst.ts";

const cfg = newConfig(newFlags({ ignoreGlobal: true }));
const md = newMyST(cfg);

interface Case {
	name: string;
	in: string;
	want?: string[];
	absent?: string[];
}

const cases: Case[] = [
	{
		name: "target labels are markup",
		in: "(contributing-volto-label)=\n\nSome prose.\n",
		want: ["<p>Some prose.</p>"],
		absent: ["volto", "label"],
	},
	{
		name: "an identifier role keeps its span, loses its braces",
		in: "Call {func}`render_page` for that.\n",
		want: ["Call <code>render_page</code> for that."],
		absent: ["{func}", "func}"],
	},
	{
		name: "a prose role's content is text",
		in: "Read the {term}`server-side rendering` glossary entry.\n",
		want: ["Read the server-side rendering glossary entry."],
		absent: ["{term}", "<code>"],
	},
	{
		name: "a titled reference is its title; a bare target is code",
		in: "See {ref}`the setup guide <setup>` and {ref}`setup`.\n",
		want: ["See the setup guide and <code>setup</code>."],
		absent: ["{ref}", "&lt;setup&gt;"],
	},
	{
		name: "substitutions are markup",
		in: "Version {{ version }} is out.\n",
		want: ["Version  is out."],
		absent: ["version }}"],
	},
	{
		name: "inline attributes keep their text",
		in: "Some [styled text]{.customclass} here.\n",
		want: ["styled text"],
		absent: ["customclass"],
	},
	{
		name: "comments and block breaks are markup",
		in: 'Before.\n\n% a comment with a misteak\n\n+++ {"meta": 1}\n\nAfter.\n',
		want: ["<p>Before.</p>", "<p>After.</p>"],
		absent: ["misteak", "meta"],
	},
	{
		name: "an attributes line is markup",
		in: "{.bg-primary}\n\nStyled paragraph.\n",
		want: ["<p>Styled paragraph.</p>"],
		absent: ["bg-primary"],
	},
	{
		name: "a prose directive is a classed div",
		in: "```{note}\n:class: dropdown\n\nAdmonition prose here.\n```\n",
		want: ['<div class="note">', "<p>Admonition prose here.</p>", "</div>"],
		absent: ["dropdown", ":class:"],
	},
	{
		name: "a colon fence is the same directive",
		in: ":::{warning}\nColon prose here.\n:::\n",
		want: ['<div class="warning">', "<p>Colon prose here.</p>"],
		absent: [":::"],
	},
	{
		name: "YAML options are markup",
		in: "```{figure} img.png\n---\nheight: 150px\nname: fig-target\n---\nThe caption is prose.\n```\n",
		want: ['<div class="figure">', "<p>The caption is prose.</p>"],
		absent: ["150px", "fig-target"],
	},
	{
		name: "a literal directive stays skipped",
		in: "```{code-block} python\nimport volto\n```\n",
		want: ["<pre>", "import volto"],
		absent: ["<p>"],
	},
	{
		name: "a literal colon directive stays skipped",
		in: ":::{math}\na^2 + b^2\n:::\n",
		want: ["<pre>", "a^2 + b^2"],
		absent: ["<p>"],
	},
	{
		name: "directives nest",
		in: "`````{note}\nOuter prose.\n\n````{tab-set}\n```{tab-item} Label\nInner prose.\n```\n````\n`````\n",
		want: [
			'<div class="note">',
			'<div class="tab-set">',
			'<div class="tab-item">',
			"<p>Inner prose.</p>",
		],
	},
	{
		name: "a plain code fence is untouched",
		in: "```python\nimport volto\n```\n",
		want: ['<pre><code class="language-python">import volto'],
	},
	{
		name: "a bare colon fence is markup",
		in: ":::\nDiv prose.\n:::\n",
		want: ["<p>Div prose.</p>"],
		absent: [":::"],
	},
];

describe("the MyST converter", () => {
	for (const c of cases) {
		test(c.name, () => {
			const html = md.render(c.in);
			for (const want of c.want ?? []) expect(html).toContain(want);
			for (const absent of c.absent ?? []) expect(html).not.toContain(absent);
		});
	}
});
