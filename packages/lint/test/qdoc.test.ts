/**
 * What the QDoc converter makes of each construct.
 *
 * Ported from `internal/lint/qdoc_test.go`. Prose is kept word-for-word,
 * commands become the elements they mean, and topic or meta commands are
 * markup with nothing to lint.
 */

import { describe, expect, test } from "bun:test";
import { qdocFragmentToHTML, qdocToHTML } from "../src/qdoc.ts";

interface Case {
	name: string;
	in: string;
	want?: string[];
	absent?: string[];
}

const cases: Case[] = [
	{
		name: "comment delimiters are markup",
		in: "/*!\n    Prose here.\n*/\n",
		want: ["<p>    Prose here.</p>"],
		absent: ["/*!", "*/"],
	},
	{
		name: "title and sections are headings",
		in: "\\title The Page Title\n\n\\section1 First Level\n\n\\section2 Second Level\n",
		want: [
			"<h1>The Page Title</h1>",
			"<h2>First Level</h2>",
			"<h3>Second Level</h3>",
		],
	},
	{
		name: "topic commands are markup",
		in: "\\page overview.html\n\\class QWidget\n\\fn void QWidget::show()\n\nProse here.\n",
		want: ["<p>Prose here.</p>"],
		absent: ["overview", "QWidget", "show"],
	},
	{
		name: "brief and note are classed paragraphs",
		in: "\\brief One brief sentence.\n\n\\note A note sentence.\n",
		want: [
			'<div class="brief">',
			"One brief sentence.",
			'<div class="note">',
			"A note sentence.",
		],
	},
	{
		name: "code runs to endcode and is skipped",
		in: "\\code\n    int x = 0;\n\\endcode\n\nProse here.\n",
		want: ["<pre><code>", "<p>Prose here.</p>"],
		absent: ["int x"],
	},
	{
		name: "omit drops its content",
		in: "Before.\n\n\\omit\nHidden prose.\n\\endomit\n\nAfter.\n",
		want: ["<p>Before.</p>", "<p>After.</p>"],
		absent: ["Hidden"],
	},
	{
		name: "c and a are code spans",
		in: "Use the \\c QWidget class with the \\a parent argument.\n",
		want: ["<code>QWidget</code>", "<code>parent</code>"],
		absent: ["\\c", "\\a"],
	},
	{
		name: "b and e keep their text",
		in: "See \\b {bold words} and \\e {emphasized words}.\n",
		want: ["<strong>bold words</strong>", "<em>emphasized words</em>"],
		absent: ["\\b", "\\e", "{"],
	},
	{
		name: "a bare link keeps its target as text",
		in: "See \\l QWidget for details.\n",
		want: ['<a href="#">QWidget</a>'],
		absent: ["\\l"],
	},
	{
		name: "a two-part link keeps its text, not its target",
		in: "See \\l {target-page.html} {the linked text} for details.\n",
		want: ['<a href="#">the linked text</a>'],
		absent: ["target-page"],
	},
	{
		name: "lists become lists",
		in: "\\list\n    \\li First item text.\n    \\li Second item text.\n\\endlist\n",
		want: ["<ul>", "<li>First item text.", "<li>Second item text.", "</ul>"],
		absent: ["\\li"],
	},
	{
		name: "tables have header and body cells",
		in: "\\table\n    \\header\n        \\li Name\n        \\li Meaning\n    \\row\n        \\li \\c Value\n        \\li Cell prose.\n\\endtable\n",
		want: [
			"<table>",
			"<th>Name",
			"<th>Meaning",
			"<td><code>Value</code>",
			"<td>Cell prose.",
		],
		absent: ["\\li"],
	},
	{
		name: "a value's constant is code, its description prose",
		in: "\\value AlignLeft Aligns with the left edge.\n",
		want: ["<code>AlignLeft</code>", "Aligns with the left edge."],
		absent: ["\\value"],
	},
	{
		name: "an image's caption is prose, its file name metadata",
		in: "\\image diagram.png A caption sentence.\n",
		want: [
			'<data class="image">diagram.png</data>',
			"<figcaption>A caption sentence.</figcaption>",
		],
	},
	{
		name: "an anchor's name is metadata",
		in: "\\target some-anchor\n\\keyword {Another Anchor}\n\nProse here.\n",
		want: [
			'<data class="anchor">some-anchor</data>',
			'<data class="anchor">Another Anchor</data>',
			"<p>Prose here.</p>",
		],
		absent: ["\\target", "\\keyword"],
	},
	{
		name: "a snippet marker is markup, and does not break its paragraph",
		in: "/*!\n    Prose one.\n//! [intro]\n    Prose two.\n*/\n",
		want: ["Prose one.", "Prose two."],
		absent: ["intro", "//!"],
	},
	{
		name: "prose about markup stays prose",
		in: "The file must be included using a <script> tag.\n\nProse after it.\n",
		want: ["using a &lt;script&gt; tag.", "<p>Prose after it.</p>"],
	},
	{
		name: "an HTML comment survives escaping",
		in: "A <!-- vale off --> toggle and a <script> tag.\n",
		want: ["<!-- vale off -->", "&lt;script&gt;"],
		absent: ["&lt;!--"],
	},
	{
		name: "sa lines are markup",
		in: "Prose here.\n\n\\sa QWidget, QObject\n",
		want: ["<p>Prose here.</p>"],
		absent: ["QWidget"],
	},
	{
		name: "an unknown inline command is masked, its text kept",
		in: "The \\unknowncmd rest of the sentence.\n",
		want: ["The  rest of the sentence."],
		absent: ["unknowncmd"],
	},
	{
		name: "a command may share the opening delimiter's line",
		in: "/*! \\page overview.html\n    \\title The Page Title\n*/\n",
		want: ["<h1>The Page Title</h1>"],
		absent: ["/*!", "*/", "overview"],
	},
	{
		name: "prose may share the opening delimiter's line",
		in: "/*! One brief sentence. */\n",
		want: ["One brief sentence."],
		absent: ["/*!", "*/"],
	},
	{
		name: "adjacent comment blocks are separate paragraphs",
		in: "/*!\n    First block.\n*/\n\n/*!\n    Second block.\n*/\n",
		want: ["<p>    First block.</p>", "<p>    Second block.</p>"],
	},
	{
		name: "build-system and type commands are markup",
		in:
			"\\qmlenum Mode\n\\qmlsingletontype Theme\n\\typealias Alias\n" +
			"\\nativetype QString\n\\cmakepackage Qt6\n\\cmakecomponent Widgets\n" +
			"\\cmaketargetitem Target\n\\qtcmakepackage Core\n" +
			"\\qtcmaketargetitem Item\n\\qtvariable widgets\n" +
			"\\tableofcontents auto\n\\dontdocument (Hidden)\n\nProse here.\n",
		want: ["<p>Prose here.</p>"],
		absent: [
			"Mode",
			"Theme",
			"Alias",
			"QString",
			"Qt6",
			"Widgets",
			"Target",
			"Core",
			"Item",
			"widgets",
			"auto",
			"Hidden",
		],
	},
	{
		name: "a comparison block's command lines are markup",
		in: "\\compareswith equality QAnyStringView\n\\endcompareswith\n\nProse here.\n",
		want: ["<p>Prose here.</p>"],
		absent: ["QAnyStringView"],
	},
	{
		name: "a conditional's expression is markup, its branches prose",
		in: "\\if defined(onlinedocs)\nOnline prose.\n\\else\nOffline prose.\n\\endif\n",
		want: ["Online prose.", "Offline prose."],
		absent: ["onlinedocs"],
	},
	{
		name: "an escaped backslash is text, not a command",
		in: "Write \\\\c to show the command.\n",
		want: ["Write \\c to show the command."],
		absent: ["<code>"],
	},
	{
		name: "a unicode code point is markup",
		in: "A bullet \\unicode 0x2022 sits here.\n",
		want: ["A bullet", "sits here."],
		absent: ["0x2022"],
	},
	{
		name: "a span's class scopes its text, which is prose",
		in: 'See \\span {class="vrheader"} {the spanned words} here.\n',
		want: ['<span class="vrheader">the spanned words</span>', "here."],
	},
	{
		name: "a div's class scopes the prose it holds",
		in: '\\div {class="note"}\nProse inside.\n\\enddiv\n',
		want: ['<div class="note">', "Prose inside.", "</div>"],
		absent: ['class="class'],
	},
	{
		name: "details keeps its summary as prose",
		in: "\\details {A summary sentence.}\nBody prose.\n\\enddetails\n",
		want: [
			'<div class="details">',
			'<p class="summary">A summary sentence.</p>',
			"Body prose.",
			"</div>",
		],
	},
	{
		name: "a subtitle is a heading",
		in: "\\title The Title\n\\subtitle The Subtitle\n",
		want: ["<h1>The Title</h1>", '<h2 class="subtitle">The Subtitle</h2>'],
	},
	{
		name: "a deprecation's version is markup, its advice prose",
		in: "\\deprecated [6.5] Use the replacement instead.\n",
		want: ["Use the replacement instead."],
		absent: ["6.5"],
	},
	{
		name: "a bare deprecation says nothing",
		in: "\\deprecated\n\nProse here.\n",
		want: ["<p>Prose here.</p>"],
		absent: ["deprecated"],
	},
	{
		name: "a cell span is markup, the cell's text prose",
		in: "\\table\n    \\row\n        \\li {2,1} Spanned cell prose.\n\\endtable\n",
		want: ["<td>Spanned cell prose."],
		absent: ["2,1"],
	},
	{
		name: "deprecated inline aliases keep their text",
		in: "See \\bold {bold words} and \\i {italic words}.\n",
		want: ["<strong>bold words</strong>", "<em>italic words</em>"],
		absent: ["\\bold", "\\i"],
	},
	{
		name: "a no-argument command keeps the words after it",
		in: "Qt \\tm is a trademark, and \\br a line break.\n",
		want: ["is a trademark", "a line break."],
		absent: ["\\tm", "\\br"],
	},
	{
		name: "modifier and metadata commands are markup",
		in:
			"\\abstract\n\\readonly\n\\required\n\\preliminary\n\\qmlabstract\n" +
			"\\qmldefault\n\\qmlenumeratorsfrom Mode\n\\omitvalue Hidden\n" +
			"\\modulestate {Technical Preview}\n\\notranslate\n\\compares strong\n" +
			"\\default true\n\\inheaderfile QtCore\n\\attribution Upstream\n" +
			"\\toc\n\\tocentry Entry\n\nProse here.\n",
		want: ["<p>Prose here.</p>"],
		absent: [
			"Mode",
			"Hidden",
			"Technical",
			"strong",
			"true",
			"QtCore",
			"Upstream",
			"Entry",
		],
	},
];

describe("the QDoc converter", () => {
	for (const c of cases) {
		test(c.name, () => {
			const html = qdocFragmentToHTML(c.in);
			for (const want of c.want ?? []) expect(html).toContain(want);
			for (const absent of c.absent ?? []) expect(html).not.toContain(absent);
		});
	}
});

/**
 * How a non-prose block ends. The code variants all close on `\endcode`, and
 * none of them may run past the comment that holds it.
 */
describe("a verbatim block's close", () => {
	const closes: Array<[string, string]> = [
		[
			"badcode closes on endcode",
			"\\badcode\n    int x = FIXME;\n\\endcode\n\nProse here.\n",
		],
		[
			"oldcode runs through newcode",
			"\\oldcode\n    FIXME old;\n\\newcode\n    FIXME new;\n\\endcode\n\nProse here.\n",
		],
		[
			"a symmetrical end is accepted too",
			"\\badcode\n    int x = FIXME;\n\\endbadcode\n\nProse here.\n",
		],
		[
			"an unterminated block ends with the comment",
			"/*!\n\\code\n    int x = FIXME;\n*/\n\n/*!\nProse here.\n*/\n",
		],
	];

	for (const [name, src] of closes) {
		test(name, () => {
			const html = qdocFragmentToHTML(src);
			expect(html).toContain("<p>Prose here.</p>");
			expect(html).not.toContain("FIXME");
		});
	}
});

/**
 * A `.qdoc` file is a file of `/*! ... *\/` comments: a licence header, a
 * `//! [name]` snippet body, and anything else between them is code, however
 * much it reads like prose.
 */
test("a whole file is read for its comments alone", () => {
	const src = `// Copyright (C) 2016 The Qt Company Ltd.
// SPDX-License-Identifier: LicenseRef-Qt-Commercial

//! [15]
md build_shared
cd build_shared
//! [15]

/*!
    \\title A Real Heading
    Real prose here.
*/

Trailing text outside any comment.
`;

	const html = qdocToHTML(src);
	for (const want of ["<h1>A Real Heading</h1>", "Real prose here."]) {
		expect(html).toContain(want);
	}
	for (const absent of ["Copyright", "SPDX", "build_shared", "Trailing"]) {
		expect(html).not.toContain(absent);
	}
});
