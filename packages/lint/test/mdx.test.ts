/**
 * What the MDX reader makes of each construct.
 *
 * Ported from `internal/lint/mdx_test.go`. ESM, expressions, tags and
 * self-closing elements are code the walker skips, while an element's children
 * stay Markdown -- a flow element is a div and an inline element a span, each
 * classed with the element's name. A `{/* ... *\/}` flow comment is an HTML
 * comment so comment-based configuration works, and everything else is
 * ordinary Markdown.
 */

import { describe, expect, test } from "bun:test";
import { jsxTagSpans, maskSpans, newMDX, opensJsx } from "../src/mdx.ts";

const md = newMDX();

interface Case {
	name: string;
	in: string;
	want?: string[];
	absent?: string[];
}

const cases: Case[] = [
	{
		name: "contiguous ESM is one skipped block",
		in: "import {A} from './a.js'\nimport b from './b.js'\n\nProse here.\n",
		want: ['<pre><code class="mdxNode mdxjsEsm">', "<p>Prose here.</p>"],
		absent: ["<p>import"],
	},
	{
		name: "a multiline export ends when its braces do",
		in: "export function A() {\n  return 1\n}\n\nProse here.\n",
		want: ['<pre><code class="mdxNode mdxjsEsm">', "<p>Prose here.</p>"],
		absent: ["<p>export"],
	},
	{
		name: "an arrow export with JSX and strings",
		in: "export const L = p => <span style={{color: 'red'}} {...p} />\n\nProse here.\n",
		want: ['<code class="mdxNode mdxjsEsm">', "<p>Prose here.</p>"],
		absent: ["<p>export"],
	},
	{
		name: "a flow comment is a comment",
		in: "{/* vale off */}\n\nProse here.\n",
		want: ["<!-- vale off -->", "<p>Prose here.</p>"],
		absent: ["mdxNode"],
	},
	{
		name: "a comment followed by prose is a paragraph",
		in: "{/* note */}Thiss paragraph.\n",
		want: ["<p><!-- note -->Thiss paragraph.</p>"],
		absent: ["mdxFlowExpression"],
	},
	{
		name: "an expression ends at its brace, whatever follows",
		in: "{/* note */}See [the docs](https://example.com/docs) now.\n\nProse here.\n",
		want: ['<a href="https://example.com/docs">', "<p>Prose here.</p>"],
		absent: ["mdxFlowExpression"],
	},
	{
		name: "a fence indented under a component is code",
		in: "<Steps>\n  <Step>\n    Run:\n\n    ```bash\n    npm install\n\n    npx it\n    ```\n\n    Prose here.\n  </Step>\n</Steps>\n",
		want: ['<pre><code class="language-bash">', "<p>Prose here.</p>"],
		absent: ["<p>npm", "<p>npx"],
	},
	{
		name: "blocks indented four spaces are not code",
		in: "    ## Setup\n\n    - one\n    - two\n\n    > quoted\n    > more\n",
		want: [
			"<h2>Setup</h2>",
			"<li>one</li>",
			"<li>two</li>",
			"<blockquote>\n<p>quoted\nmore</p>",
		],
		absent: ["<pre>", "<li>one\n<ul>"],
	},
	{
		name: "a flow expression is skipped",
		in: "{(function () {\n  return 'a { in a string'\n})()}\n\nProse here.\n",
		want: ['<pre><code class="mdxNode mdxFlowExpression">', "<p>Prose here.</p>"],
		absent: ["<p>{("],
	},
	{
		name: "a self-closing element with expression attributes",
		in: "<Chart data={population} label={'a > b'} />\n\nProse here.\n",
		want: ['<code class="mdxNode mdxJsxFlowElement">', "<p>Prose here.</p>"],
		absent: ["<p><Chart", "<chart"],
	},
	{
		name: "an element's children are prose in a classed div",
		in: '<div className="note">\n  > Some notable things!\n</div>\n\nProse here.\n',
		want: ['<div class="div">', "<blockquote>", "</div>", "<p>Prose here.</p>"],
		absent: ["mdxNode", "note"],
	},
	{
		name: "multiline attributes render as nothing, like a container's tags",
		in: "<Component\n  open\n  x={1}\n  icon={<Icon />}\n/>\n\nProse here.\n",
		want: ["<p>Prose here.</p>"],
		absent: ["<p><Component", "x={1}", "mdxJsxFlowElement"],
	},
	{
		name: "inline JSX children stay prose",
		in: "An <External>XXX</External> component TODO.\n",
		want: ['An <span class="External">XXX</span> component TODO.'],
		absent: ["mdxNode"],
	},
	{
		name: "a member-expression component",
		in: "Use the <myComponents.thisOne /> component.\n",
		want: ['<code class="mdxNode mdxJsxTextElement">'],
		absent: ["<mycomponents.thisone"],
	},
	{
		name: "an inline expression is a code span",
		in: "Two is: {Math.PI * 2}, TODO\n",
		want: [
			'Two is: <code class="mdxNode mdxTextExpression">{Math.PI * 2}</code>, TODO',
		],
	},
	{
		name: "a heading attribute is a code span",
		in: "## Some Markdown {#initial-setup}\n",
		want: [
			"Some Markdown",
			'<code class="mdxNode mdxTextExpression">{#initial-setup}</code>',
		],
	},
	{
		name: "autolinks are still links",
		in: "See <https://example.com/config> for details.\n",
		want: ['<a href="https://example.com/config">'],
		absent: ["mdxNode"],
	},
	{
		name: "indented lines are a paragraph, not code",
		in: "Intro.\n\n    XXX = False\n    more here\n",
		want: ["<p>XXX = False\nmore here</p>"],
		absent: ["<pre><code>XXX"],
	},
	{
		name: "a fragment's children are prose",
		in: "<>\nInside a fragment.\n</>\n\nProse here.\n",
		want: ["<div>\n<p>Inside a fragment.</p>\n</div>", "<p>Prose here.</p>"],
		absent: ["mdxNode"],
	},
	{
		name: "a nested same-name element on one line stays inside its parent",
		in: "<Box>\n  <Box>inner</Box>\n</Box>\n\nProse here.\n",
		want: [
			'<div class="Box">\n<p><span class="Box">inner</span></p>\n</div>',
			"<p>Prose here.</p>",
		],
		absent: ["mdxNode"],
	},
	{
		name: "an element on one line with text is a paragraph",
		in: '<Tip>This is a tip</Tip>\n\n<Badge color="orange">Deprecated</Badge> since v2.\n',
		want: [
			'<p><span class="Tip">This is a tip</span></p>',
			'<p><span class="Badge">Deprecated</span> since v2.</p>',
		],
		absent: ["mdxJsxFlowElement"],
	},
	{
		name: "an element on one line without text is code",
		in: '<video src="a.mp4"></video>\n\n<Box><Chart data={x} /></Box>\n\nProse here.\n',
		want: [
			'<code class="mdxNode mdxJsxFlowElement">&lt;video',
			'<code class="mdxNode mdxJsxFlowElement">&lt;Box&gt;',
			"<p>Prose here.</p>",
		],
		absent: ["<p>&lt;"],
	},
	{
		name: "nested same-name elements close in order",
		in: "<Box>\n\nOuter start.\n\n<Box>\n\nInner text.\n\n</Box>\n\nOuter end.\n\n</Box>\n\nProse here.\n",
		want: [
			"<p>Outer start.</p>",
			"<p>Inner text.</p>",
			"<p>Outer end.</p>",
			"<p>Prose here.</p>",
		],
		absent: ["mdxNode"],
	},
	{
		name: "a container's attributes are not prose",
		in: '<AstroAside type="info" x={a > b}>\n  Renders inside a colored box.\n</AstroAside>\n\nProse here.\n',
		want: [
			'<div class="AstroAside">',
			"<p>Renders inside a colored box.</p>",
			"<p>Prose here.</p>",
		],
		absent: ["info", "a &gt; b"],
	},
	{
		name: "markdown children keep their structure",
		in: "<Steps>\n\n1. First point here.\n\n2. Second point here.\n\n</Steps>\n\nProse here.\n",
		want: [
			'<div class="Steps">',
			"<ol>",
			"<li>",
			"First point here.",
			"<p>Prose here.</p>",
		],
		absent: ["mdxNode"],
	},
	{
		name: "a JSX tag quoted in a fence doesn't close the element",
		in: "<Steps>\n\n```\n</Steps>\n```\n\nStill inside.\n\n</Steps>\n\nProse here.\n",
		want: ["<p>Still inside.</p>", "<p>Prose here.</p>"],
		absent: ["<p>&lt;/Steps&gt;"],
	},
	{
		name: "a member-expression container's dots become hyphens",
		in: "<my.Component>\n\nText here.\n\n</my.Component>\n\nProse here.\n",
		want: ['<div class="my-Component">', "<p>Text here.</p>", "<p>Prose here.</p>"],
		absent: ["my.Component<"],
	},
	{
		name: "an escaped quote inside an attribute expression",
		in: "<Table rows={[{d: 'the cluster\\'s version', e: \"a \\\"quoted\\\" word\"}]} />\n\nProse here.\n",
		want: ['<code class="mdxNode mdxJsxFlowElement">', "<p>Prose here.</p>"],
		absent: ["<p>Prose here.</p></code>"],
	},
	{
		name: "an export whose template literal spans lines",
		in: "export const c = `a(\n  \\`b\\`, {x}\n)`;\n\nProse here.\n",
		want: ['<pre><code class="mdxNode mdxjsEsm">', "<p>Prose here.</p>"],
		absent: ["<p>export", "<p>)`"],
	},
	{
		name: "a fragment with an apostrophe inside an attribute expression",
		in: "<C\n  title={<><Code>\n    X\n  </Code> d'env (note)</>\n  }\n>\n  Body here.\n</C>\n\nProse here.\n",
		want: ["<p>Body here.</p>", "<p>Prose here.</p>"],
		absent: ["<p>X", "<p>d'env"],
	},
	{
		name: "JSX text inside a flow expression",
		in: "{\n\n<table><tr><td>(per month) don't</td></tr></table>\n\n}\n\nProse here.\n",
		want: ['<pre><code class="mdxNode mdxFlowExpression">', "<p>Prose here.</p>"],
		absent: ["<p>(per", "<p>}"],
	},
	{
		name: "JSX returned from a function inside an expression",
		in: "{(() => { return <b>don't</b> })()}\n\nProse here.\n",
		want: ['<code class="mdxNode mdxFlowExpression">', "<p>Prose here.</p>"],
		absent: ["<p>{("],
	},
	{
		name: "a type argument inside an expression is not JSX",
		in: "{useState<string>('x')}\n\nProse here.\n",
		want: ['<code class="mdxNode mdxFlowExpression">', "<p>Prose here.</p>"],
		absent: ["<p>{use"],
	},
];

describe("the MDX converter", () => {
	for (const c of cases) {
		test(c.name, () => {
			const html = md.render(c.in);
			for (const want of c.want ?? []) expect(html).toContain(want);
			for (const absent of c.absent ?? []) expect(html).not.toContain(absent);
		});
	}
});

describe("opensJsx", () => {
	test("a tag, a fragment and a close tag open one", () => {
		expect(opensJsx("<Tip>", 0)).toBe(true);
		expect(opensJsx("<>", 0)).toBe(true);
		expect(opensJsx("</Tip>", 0)).toBe(true);
		expect(opensJsx("<my.Component ", 0)).toBe(true);
	});

	test("an autolink, a comment and a comparison do not", () => {
		expect(opensJsx("<https://example.com>", 0)).toBe(false);
		expect(opensJsx("<!-- note -->", 0)).toBe(false);
		expect(opensJsx("<user@host>", 0)).toBe(false);
		expect(opensJsx("a < b", 2)).toBe(false);
	});
});

/**
 * What is blanked out of the search context: the tags of JSX elements, whose
 * attributes the walker never sees. Code the walker does see -- ESM,
 * expressions, fences -- is left for it, and the prose and comments are never
 * touched.
 */
test("the JSX tags are masked out of the source", () => {
	const src =
		'import A from \'./a\'\n\n<Update rss={{ title:"Same words" }}>\n\n## Same words\n\n</Update>\n\n{/* vale off */}\n\nA <Badge color="red">tag</Badge> and {props.x} here.\n\n```js\nconst y = 1\n```\n\n<Card\n  title={\'Alt words\'}\n/>\n\nAlt words again.\n';
	const got = maskSpans(src, jsxTagSpans(src));

	// A childless element spanning lines is tags and nothing else, masked like
	// a container's tags and rendered as nothing.
	for (const absent of [
		"rss=",
		"title:",
		"</Update>",
		"color=",
		"</Badge>",
		"title={'Alt words'}",
	]) {
		expect(got).not.toContain(absent);
	}
	for (const present of [
		"import A",
		"## Same words",
		"{/* vale off */}",
		"A ",
		"tag",
		" and ",
		"{props.x}",
		" here.",
		"const y",
		"Alt words again.",
	]) {
		expect(got).toContain(present);
	}

	// Masking moves nothing.
	expect(got.length).toBe(src.length);
	expect(got.split("\n").length).toBe(src.split("\n").length);
});
