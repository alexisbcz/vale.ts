import { describe, expect, test } from "bun:test";
import { Block } from "@vale-ts/core";
import {
	allStringsInSlice,
	compileSelector,
	docID,
	docSelectorMap,
	docSelectors,
	expandScopes,
	newScope,
	newSelector,
	Selector,
	scopeBases,
	splitOutside,
	standardSelector,
} from "../src/index.ts";

const sel = `section:has(> h2:contains("A & B"))`;

test("a selector's sections are its dotted parts", () => {
	const s1 = new Selector(["text.comment.line.py"], false);
	const s2 = new Selector(["text.comment"], false);

	expect(allStringsInSlice(["text", "comment", "line", "py"], s1.sections())).toBe(
		true,
	);
	expect(s2.has("py")).toBe(false);
	for (const part of s1.sections()) expect(s1.has(part)).toBe(true);
});

test("a leading tilde negates a selector", () => {
	const s = newSelector(["~heading", "h2"]);
	expect(s.negated).toBe(true);
	expect(s.value).toEqual(["heading", "h2"]);
});

describe("splitOutside leaves a selector's own separators alone", () => {
	const cases: Array<[string, string, string[]]> = [
		["sentence & ~heading", "&", ["sentence ", " ~heading"]],
		["text.list", ".", ["text", "list"]],
		[`sentence & doc(${sel})`, "&", ["sentence ", ` doc(${sel})`]],
		["doc(h2.note)", ".", ["doc(h2.note)"]],
		[`doc(p:contains("a)b")) & text`, "&", [`doc(p:contains("a)b")) `, " text"]],
	];

	for (const [input, sep, want] of cases) {
		test(`${input} on ${sep}`, () => {
			expect(splitOutside(input, sep)).toEqual(want);
		});
	}
});

test("a scope declares its doc(...) terms under their ids", () => {
	const scope = `sentence & ~doc(${sel}) & doc(h2 + p)`;
	expect(docSelectorMap(scope)).toEqual(
		new Map([
			[docID(sel), sel],
			[docID("h2 + p"), "h2 + p"],
		]),
	);
	expect(docSelectors(scope).sort()).toEqual([sel, "h2 + p"].sort());
	expect(docSelectors("text.list")).toEqual([]);
});

describe("the three meanings of a doc(...) term", () => {
	// The block scopes are the ones the linter builds: a paragraph inside a
	// matched element carries `in.<id>`, and the element itself is linted as
	// `doc.<id>`.
	const id = docID(sel);
	const inside = `text.in.${id}.md`;
	const fragment = `sentence.text.in.${id}.md`;
	const outside = "text.md";
	const selection = `doc.${id}.md`;

	const cases: Array<[string, string, boolean]> = [
		// Alone: the element is the block, and only that block.
		[`doc(${sel})`, selection, true],
		[`doc(${sel})`, inside, false],
		[`doc(${sel})`, outside, false],

		// Beside a scope: that scope, narrowed to the element.
		[`text & doc(${sel})`, inside, true],
		[`text & doc(${sel})`, outside, false],
		[`text & doc(${sel})`, selection, false],
		[`sentence & doc(${sel})`, fragment, true],
		[`sentence & doc(${sel})`, inside, false],

		// Negated: everywhere but the element, and never the selection.
		[`~doc(${sel})`, outside, true],
		[`~doc(${sel})`, inside, false],
		[`~doc(${sel})`, selection, false],
		[`~doc(${sel})`, `doc.${docID("h2 + p")}.md`, false],
	];

	for (const [rule, scope, want] of cases) {
		test(`${rule} on ${scope}`, () => {
			const blk = new Block("", "text", scope);
			expect(newScope([rule]).matches(blk)).toBe(want);
		});
	}
});

describe("which blocks a declared scope reaches", () => {
	// Matching is by containment: a rule matches a block when every section of
	// the rule's scope appears somewhere in the block's. The block scopes are
	// the ones the linter actually builds -- `text.<element>` from the reader,
	// `paragraph.<scope>` from splitting, `sentence.<scope>` from segmentation.
	const cases: Array<[string[], string, boolean]> = [
		// `paragraph` names splitting's wrapper, carried only by body text.
		[["paragraph"], "paragraph.text.md", true],
		[["paragraph"], "text.md", false],
		[["paragraph"], "text.heading.h2.md", false],
		[["paragraph"], "text.table.cell.md", false],
		[["paragraph"], "text.list.md", false],
		[["paragraph"], "text.blockquote.md", false],
		[["paragraph"], "sentence.text.md", false],

		// `sentence` names segmentation's wrapper, carried by every kind of prose.
		[["sentence"], "sentence.text.md", true],
		[["sentence"], "sentence.text.heading.h2.md", true],
		[["sentence"], "sentence.text.list.md", true],
		[["sentence"], "text.md", false],
		[["sentence"], "paragraph.text.md", false],

		// Element scopes reach their element and no other. They do not reach
		// the element's sentence fragments: the full block carries every
		// section a fragment does, so a rule that does not ask for `sentence`
		// loses nothing -- and running it per fragment reported `a.` as a
		// whole heading.
		[["heading"], "text.heading.h2.md", true],
		[["heading"], "sentence.text.heading.h2.md", false],
		[["text"], "sentence.text.md", false],
		[["heading.h2"], "text.heading.h2.md", true],
		[["heading.h3"], "text.heading.h2.md", false],
		[["heading"], "text.md", false],
		[["table.header"], "text.table.header.md", true],
		[["table.header"], "text.table.cell.md", false],
		[["table.cell"], "text.table.cell.md", true],
		[["table"], "text.table.header.md", true],
		[["table"], "text.table.cell.md", true],
		[["list"], "text.list.md", true],
		[["list"], "text.md", false],
		[["blockquote"], "text.blockquote.md", true],
		[["blockquote"], "text.md", false],

		// Inline and raw scopes are siblings of `text`, not children of it.
		[["link"], "link.md", true],
		[["link"], "text.md", false],
		[["code"], "code.md", true],
		[["raw"], "raw.md", true],
		[["raw"], "text.md", false],
		[["text"], "link.md", false],
		[["text"], "raw.md", false],

		// Negation excludes an element and keeps everything else.
		[["~blockquote"], "text.md", true],
		[["~blockquote"], "text.blockquote.md", false],
		[["~blockquote & ~heading"], "text.md", true],
		[["~blockquote & ~heading"], "text.heading.h2.md", false],
		[["~blockquote & ~heading"], "text.blockquote.md", false],

		// Several scopes are a union.
		[["heading", "list"], "text.list.md", true],
		[["heading", "list"], "text.blockquote.md", false],
	];

	for (const [rule, scope, want] of cases) {
		test(`${rule.join(",")} vs ${scope}`, () => {
			const blk = new Block("", "text", scope, 1);
			expect(newScope(rule).matches(blk)).toBe(want);
		});
	}
});

test("a negated inline scope is recorded so the rule can leave it out", () => {
	const s = newScope(["~heading & ~link"]);
	expect(s.excluded).toEqual(["link"]);
	expect(s.matches(new Block("", "text", "text.md"))).toBe(true);
	expect(s.matches(new Block("", "text", "text.heading.h2.md"))).toBe(false);
	expect(s.matches(new Block("", "text", "link.md"))).toBe(false);
	expect(newScope(["~heading"]).excluded).toEqual([]);
	expect(newScope(["~quote"]).excluded).toEqual(["quote"]);
});

describe("a named scope stands in for its expression", () => {
	const names: Record<string, string> = {
		methods: `doc(section:has(> h2:contains("Methods")))`,
		lead: "text & doc(h1 + p)",
	};

	const cases: Array<[string, unknown, string[] | null]> = [
		["none", null, null],
		["unnamed string", "heading", ["heading"]],
		["unnamed list", ["heading", "~list"], ["heading", "~list"]],
		["alone", "methods", [`doc(section:has(> h2:contains("Methods")))`]],
		["negated", "~methods", [`~doc(section:has(> h2:contains("Methods")))`]],
		[
			"in a chain",
			"sentence & methods",
			[`sentence & doc(section:has(> h2:contains("Methods")))`],
		],
		["chain alone", "lead", ["text & doc(h1 + p)"]],
		["chain in a chain", "list & lead", ["list & text & doc(h1 + p)"]],
		[
			"list of names",
			["methods", "list"],
			[`doc(section:has(> h2:contains("Methods")))`, "list"],
		],
	];

	for (const [name, scope, want] of cases) {
		test(name, () => {
			expect(expandScopes(scope, names)).toEqual(want);
		});
	}

	test("a chain has no opposite", () => {
		expect(() => expandScopes("~lead", names)).toThrow();
	});

	test("a number is not a scope", () => {
		expect(() => expandScopes(42, names)).toThrow();
	});
});

describe("standardSelector spells Level 4 in what the parser reads", () => {
	const cases: Array<[string, string]> = [
		["h2", "h2"],
		[":is(h2, h3)", ":not(:not(h2, h3))"],
		[":where(h2, h3)", ":not(:not(h2, h3))"],
		[":IS(h2)", ":not(:not(h2))"],
		[
			`section:has(> :is(h1, h2):contains("m"))`,
			`section:has(> :not(:not(h1, h2)):contains("m"))`,
		],
		[
			`:is(h2:not(:contains("x")), h3) + p`,
			`:not(:not(h2:not(:contains("x")), h3)) + p`,
		],
		[`h2:contains(":is(")`, `h2:contains(":is(")`],
		[`h2:contains(':is(')`, `h2:contains(':is(')`],
		[":is(:is(h1, h2), h3)", ":not(:not(:not(:not(h1, h2)), h3))"],
		["section:has(> h2, > h3)", "section:has(> h2, > h3)"],
	];

	for (const [input, want] of cases) {
		test(input, () => {
			expect(standardSelector(input)).toBe(want);
		});
	}
});

describe("compileSelector", () => {
	for (const s of [
		sel,
		"section:has( >h2)",
		"h2 + p",
		"ul:not(p + ul)",
		"h2, h3",
		"section:has(h2, h3)",
		"section:haschild(h2, h3)",
		"section:is(:has(> h3), :has(> p + h2))",
	]) {
		test(s, () => {
			expect(() => compileSelector(s)).not.toThrow();
		});
	}

	for (const s of ["h2:has(", ":is(", ":is(h2"]) {
		test(`${s} is refused`, () => {
			expect(() => compileSelector(s)).toThrow();
		});
	}
});

describe("scopeBases names the block families a scope needs built", () => {
	const cases: Array<[string, string[]]> = [
		["paragraph", ["paragraph"]],
		["paragraph.md", ["paragraph"]],
		["paragraph & ~heading", ["paragraph"]],
		["sentence & ~blockquote & ~list", ["sentence"]],
		["paragraph & sentence", ["paragraph", "sentence"]],
		["sentence.heading & ~h2", ["sentence"]],

		// A negated term asks for a family's absence: nothing to build.
		["~heading", []],
		["~blockquote & ~heading", []],
	];

	for (const [input, want] of cases) {
		test(input, () => {
			expect(scopeBases(input)).toEqual(want);
		});
	}
});
