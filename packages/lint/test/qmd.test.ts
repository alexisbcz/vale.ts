/**
 * What the Quarto reader makes of each construct.
 *
 * Ported from `internal/lint/qmd_test.go`. Fenced divs become classed divs
 * whose content is linted, and attributes and shortcodes render as nothing at
 * all. The code cells are Markdown already -- fenced code and code spans --
 * and stay skipped.
 */

import { describe, expect, test } from "bun:test";
import { newQuarto, quartoClasses } from "../src/qmd.ts";

const md = newQuarto();

interface Case {
	name: string;
	in: string;
	want?: string[];
	absent?: string[];
}

const cases: Case[] = [
	{
		name: "a callout is a classed div",
		in: "::: {.callout-note}\nCallout prose here.\n:::\n",
		want: ['<div class="callout-note">', "<p>Callout prose here.</p>", "</div>"],
		absent: [":::"],
	},
	{
		name: "attributes beyond classes are dropped",
		in: '::: {.callout-tip title="A titled tip" #tip-1}\nTip prose.\n:::\n',
		want: ['<div class="callout-tip">', "<p>Tip prose.</p>"],
		absent: ["titled", "tip-1"],
	},
	{
		name: "a bare word is a class",
		in: "::: warning\nBare-word prose.\n:::\n",
		want: ['<div class="warning">', "<p>Bare-word prose.</p>"],
	},
	{
		name: "divs nest by fence length",
		in: ':::: {.columns}\n::: {.column width="40%"}\nLeft prose.\n:::\n::: {.column width="60%"}\nRight prose.\n:::\n::::\n',
		want: [
			'<div class="columns">',
			'<div class="column">',
			"<p>Left prose.</p>",
			"<p>Right prose.</p>",
		],
		absent: ["40%", ":::"],
	},
	{
		name: "a bare fence closes the innermost div",
		in: "::: {.a}\nOuter prose.\n\n::: {.b}\nInner prose.\n:::\n\nStill outer.\n:::\n\nOutside.\n",
		want: [
			'<div class="a">',
			'<div class="b">',
			"<p>Inner prose.</p>",
			"<p>Still outer.</p>",
			"<p>Outside.</p>",
		],
		absent: [":::"],
	},
	{
		name: "a stray closer is markup",
		in: "Before.\n\n:::\n\nAfter.\n",
		want: ["<p>Before.</p>", "<p>After.</p>"],
		absent: [":::"],
	},
	{
		name: "a code cell stays skipped, options and all",
		in: '```{r}\n#| label: fig-plot\n#| fig-cap: "A caption"\nplot(cars)\n```\n',
		want: ["<pre><code"],
		absent: ["<p>"],
	},
	{
		name: "heading attributes are markup",
		in: "## Overview {#sec-overview}\n\nProse here.\n",
		want: ["Overview", "<p>Prose here.</p>"],
		absent: ["sec-overview"],
	},
	{
		name: "inline attributes keep their text",
		in: "Prose with [styled text]{.underline} in it.\n",
		want: ["styled text"],
		absent: ["underline"],
	},
	{
		name: "shortcodes are markup",
		in: "{{< video https://example.com/v.mp4 >}}\n\nPress {{< kbd F5 >}} to run.\n",
		want: ["Press", "to run."],
		absent: ["video", "kbd"],
	},
	{
		name: "an inline code cell is a code span",
		in: "The mean is `{python} np.mean(x)` overall.\n",
		want: ["<code>{python} np.mean(x)</code>"],
	},
];

describe("the Quarto converter", () => {
	for (const c of cases) {
		test(c.name, () => {
			const html = md.render(c.in);
			for (const want of c.want ?? []) expect(html).toContain(want);
			for (const absent of c.absent ?? []) expect(html).not.toContain(absent);
		});
	}
});

describe("quartoClasses", () => {
	test("the braced form keeps only the classes", () => {
		expect(quartoClasses('{.callout-tip title="A titled tip" #tip-1}')).toEqual([
			"callout-tip",
		]);
	});

	test("the bare-word form is one class", () => {
		expect(quartoClasses("warning")).toEqual(["warning"]);
	});

	test("an opener naming nothing has no class", () => {
		expect(quartoClasses("{#tip-1}")).toEqual([]);
	});
});
