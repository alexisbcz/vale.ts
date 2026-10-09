/**
 * Every selector that appears in Vale's own view definitions, run against the
 * fixture the view is configured for.
 *
 * The views live in `testdata/styles/config/views` and the fixtures in
 * `testdata/fixtures/views`; the pairing comes from the `.vale.ini` beside
 * them. A selector that stops working here is a view that stops working.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { selectStrings, selectValues } from "../src/dasel.ts";
import { fileToValue } from "../src/structured.ts";

const FIXTURES = `${import.meta.dir}/fixtures`;

function load(name: string): unknown {
	const dot = name.lastIndexOf(".");
	return fileToValue({
		content: readFileSync(`${FIXTURES}/${name}`, "utf8"),
		realExt: name.slice(dot),
	}).value;
}

describe("Vale's own views", () => {
	// Vale.yml, on a rule definition.
	test("a bare property", () => {
		expect(selectValues(load("Rule.yml"), "description")).toEqual([
			"Bro culture terminology can can really reduce the number of people likely to show interest.",
		]);
	});

	// NewLine.yml -- a double-quoted scalar folded with `\` over two lines.
	test("a dotted path", () => {
		expect(selectValues(load("newline.yml"), "info.description")).toEqual([
			"Line 1 Line 2",
		]);
	});

	// Issue1018.yml.
	test("two dotted paths over the same object", () => {
		const v = load("issue1018.yml");
		expect(selectValues(v, "info.description")).toEqual([
			"Contains misspeling when wrapped",
		]);
		// A folded block is read as a literal one, so its newline survives.
		expect(selectValues(v, "info.summary")).toEqual([
			"Includes trailing space.\nHas misspeled second line.\n",
		]);
	});

	// OpenAPI.yml, on API.yml.
	test("search and map over a whole document", () => {
		const v = load("API.yml");
		expect(selectValues(v, "info.title")).toEqual(["sample API"]);
		expect(selectValues(v, 'search(has("description")).map(description)')).toEqual([
			"Optional multiline or single-line description in [CommonMark](http://commonmark.org/help/) or HTML.",
			"Optional server description, e.g. Main (production) serrver",
			"Optional server description, e.g.\nInternal staging serrver for testing\n",
			"Optional server description, e.g. Main (production) serrver",
			"Optional extended description in CommonMark or HTML.",
			"A JSON array of user names",
		]);
		expect(selectValues(v, 'search(has("summary")).map(summary)')).toEqual([
			"Returns a list of users for the servver.",
		]);
	});

	// Petstore.yml, on Petstore.yaml.
	test("all() over a map's values, twice, then property()", () => {
		const v = load("Petstore.yaml");
		expect(selectValues(v, "info.title")).toEqual([
			"Swagger Petstore - OpenAPI 3.0",
		]);
		expect(selectStrings(v, "info.description")[0]).toStartWith(
			"This is a sample Pet Store Server based on the OpenAPI 3.0 specification.",
		);
		expect(selectValues(v, "tags.all().description")).toEqual([
			"Everything about your Pets",
			"Access to Petstore orders",
			"Operations about user",
		]);

		// `paths` is a map of path to a map of method to operation, so two
		// `all()`s reach the 19 operations, each of which names both
		// properties.
		const props = selectStrings(
			v,
			"paths.all().all().property(summary,description)",
		);
		expect(props).toHaveLength(38);
		expect(props.slice(0, 4)).toEqual([
			"Add a new pet to the store",
			"Add a new pet to the store",
			"Update an existing pet",
			"Update an existing pet by Id",
		]);
	});

	// Ansible.yml, on ansible.yml -- the one view that needs `?`.
	test("optional traversal skips what is missing", () => {
		const v = load("ansible.yml");
		expect(selectValues(v, "chapters.all().title")).toEqual([
			"reusing Code with Ansible Roles and Coent Collections",
		]);
		expect(selectValues(v, "chapters.all().goal")).toEqual([
			"Use Ansible Roles and Ansible Content Collections to devlop playbooks more quickly and to reuse Ansible code.",
		]);

		// The second section has no `objectives`, which without the `?` is an
		// error rather than a miss.
		const expr = "chapters.all().topics.all().sections.all().objectives?.all()";
		expect(selectValues(v, expr)).toEqual([
			"Define the purose of an Ansible Role, its structure, and how roles are used in playbooks.",
		]);
		expect(() =>
			selectValues(
				v,
				"chapters.all().topics.all().sections.all().objectives.all()",
			),
		).toThrow(/not found/);
	});

	// GitHubActions.yml, on github-workflow.json.
	test("search under one property of a large JSON schema", () => {
		const v = load("github-workflow.json");
		const under = selectStrings(
			v,
			'definitions.search(has("description")).map(description)',
		);
		const whole = selectStrings(v, 'search(has("description")).map(description)');
		expect(under).toHaveLength(56);
		// `definitions` is one subtree of a document that describes more.
		expect(whole.length).toBeGreaterThan(under.length);
		for (const d of under) expect(whole).toContain(d);
	});
});

describe("the v2 spelling", () => {
	test("a selector may begin with a dot", () => {
		expect(selectValues(load("newline.yml"), ".info.description")).toEqual([
			"Line 1 Line 2",
		]);
		expect(selectValues(load("Rule.yml"), ".description")).toHaveLength(1);
	});

	test("`[]` is every element", () => {
		expect(selectValues(load("ansible.yml"), ".chapters.[].title")).toEqual([
			"reusing Code with Ansible Roles and Coent Collections",
		]);
	});

	test("v3 refuses `[]` and v2 refuses `all()`, so each is read by one", () => {
		const v = load("ansible.yml");
		expect(selectValues(v, "chapters.[].keyword")).toEqual(["roles"]);
		expect(selectValues(v, "chapters.all().keyword")).toEqual(["roles"]);
	});
});

describe("the other steps", () => {
	const doc = {
		items: [{ name: "first" }, { name: "second" }, { name: "third" }],
		note: "a note",
	};

	test("index(n) and [n]", () => {
		expect(selectValues(doc, "items.index(1).name")).toEqual(["second"]);
		expect(selectValues(doc, "items[2].name")).toEqual(["third"]);
		expect(selectValues(doc, "items.[0].name")).toEqual(["first"]);
		expect(() => selectValues(doc, "items[9].name")).toThrow(/out of range/);
		expect(() => selectValues(doc, "note[0]")).toThrow(/cannot index/);
	});

	test("map applies a selector to each element", () => {
		expect(selectValues(doc, "items.map(name)")).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	test("has() is a predicate on the current value", () => {
		expect(selectValues(doc, 'search(has("name"))')).toEqual([
			{ name: "first" },
			{ name: "second" },
			{ name: "third" },
		]);
		// A string has no properties, so nothing matches it.
		expect(selectValues({ a: "x" }, 'search(has("a"))')).toEqual([{ a: "x" }]);
	});

	test("filter keeps the elements a predicate holds for", () => {
		const chat = {
			messages: [
				{ role: "user", content: "asked" },
				{ role: "assistant", content: "answered" },
			],
		};
		// Written either way: `all()` hands the list on, and the filter reads
		// the elements of it.
		for (const expr of [
			"messages.all().filter(equal(role,assistant)).content",
			"messages.filter(equal(role,assistant)).content",
		]) {
			expect(selectStrings(chat, expr)).toEqual(["answered"]);
		}
	});

	test("all() reads a list root, so a document need not be an object", () => {
		expect(
			selectStrings([{ title: "first" }, { title: "second" }], "all().title"),
		).toEqual(["first", "second"]);
	});

	test("a list stays one item, so a view's join can work on it", () => {
		const nb = {
			cells: [
				{ cell_type: "markdown", source: ["# Title\n", "Prose."] },
				{ cell_type: "markdown", source: "One string cell." },
			],
		};
		expect(selectValues(nb, "cells.all().source")).toEqual([
			["# Title\n", "Prose."],
			"One string cell.",
		]);
	});

	test("selectStrings drops what is not a string", () => {
		expect(selectStrings({ a: 1, b: "two", c: true }, "all()")).toEqual(["two"]);
	});
});

describe("errors name both dialects", () => {
	test("a malformed selector", () => {
		expect(() => selectValues({ a: 1 }, "this.is.not.valid.[[[")).toThrow(
			/unbalanced brackets.*as a v2 selector: unbalanced brackets/s,
		);
	});

	test("a construct neither dialect here supports", () => {
		const chat = { messages: [{ role: "user" }] };
		expect(() =>
			selectValues(chat, 'messages.filter(role == "assistant").content'),
		).toThrow(/not a predicate.*as a v2 selector: unexpected function call/s);
	});

	test("a property on a list", () => {
		expect(() =>
			selectValues({ messages: [{ role: "user" }] }, "messages.role"),
		).toThrow(
			/expected map, got array.*as a v2 selector: cannot use property selector on non map\/struct types/s,
		);
	});

	test("a missing property", () => {
		expect(() => selectValues({ info: {} }, "info.description")).toThrow(
			/"description" not found.*as a v2 selector: property not found: description/s,
		);
	});

	test("an unknown function", () => {
		expect(() => selectValues({ a: 1 }, "len(a)")).toThrow(/unknown function/);
	});

	test("an empty selector", () => {
		expect(() => selectValues({ a: 1 }, "")).toThrow(/empty/);
		expect(() => selectValues({ a: 1 }, "a..b")).toThrow(/empty step/);
	});
});
