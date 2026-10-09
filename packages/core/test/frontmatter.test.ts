/**
 * Front matter read as scoped values.
 *
 * Ported from `internal/core/frontmatter_test.go`. Go's `FrontMatterValues`
 * takes the source lines as a second argument; the port reads them from the
 * block itself, so `frontMatterValues` takes one.
 */

import { describe, expect, test } from "bun:test";
import { frontMatterValues, parseFrontMatter } from "../src/frontmatter.ts";

describe("frontMatterValues", () => {
	// A field is placed by its scalar, whatever quoting it uses, and a field
	// that is not a string is left out.
	test("places each string field and leaves the rest out", () => {
		const fm =
			'---\ntitle: "My document"\ndate: 2024-01-01\ntags: [a, b]\nsummary: plain text\n---\n';
		const values = frontMatterValues(fm);

		const want = [
			{ scope: "frontmatter.title", text: "My document", line: 2, column: 9 },
			{ scope: "frontmatter.summary", text: "plain text", line: 5, column: 10 },
		];

		expect(values).toHaveLength(want.length);
		for (const [i, w] of want.entries()) {
			const got = values[i]!;
			const sv = got.values[0]!;
			expect(
				{ scope: got.scope, text: sv.text, line: sv.line, column: sv.column },
				`value ${i}`,
			).toEqual(w);
		}
	});

	// JSON front matter sits between `;;;` lines and is placed the same way.
	test("JSON front matter", () => {
		const fm = ';;;\n{\n  "title": "My document"\n}\n;;;\n';
		const values = frontMatterValues(fm);

		expect(values).toHaveLength(1);
		const sv = values[0]!.values[0]!;
		expect({ text: sv.text, line: sv.line, column: sv.column }).toEqual({
			text: "My document",
			line: 3,
			column: 13,
		});
	});

	// Not from the Go suite: a block scalar's indicator sits on the key's line,
	// so the value has to be placed on the first line of the block.
	test("a block scalar is placed on its first content line", () => {
		const fm = "---\nsummary: |\n  The body.\n---\n";
		const values = frontMatterValues(fm);

		expect(values).toHaveLength(1);
		const sv = values[0]!.values[0]!;
		expect(sv.line).toBe(3);
		expect(sv.column).toBe(3);
	});
});

// Not from the Go suite, but the values above are only ever read from a block
// `parseFrontMatter` found, and a condition reads the same block's data.
describe("parseFrontMatter", () => {
	test("reads each delimiter form", () => {
		expect(parseFrontMatter("---\ndraft: true\n---\n\nText.\n")).toMatchObject({
			kind: "yaml",
			data: { draft: true },
			raw: "---\ndraft: true\n---",
		});
		expect(parseFrontMatter("+++\ndraft = true\n+++\n\nText.\n")).toMatchObject({
			kind: "toml",
			data: { draft: true },
		});
		expect(parseFrontMatter(';;;\n{"draft": true}\n;;;\n')).toMatchObject({
			kind: "json",
			data: { draft: true },
		});
	});

	// A block has to start on the first line: a `---` further down is a
	// thematic break, not metadata.
	test("a delimiter further down is not front matter", () => {
		expect(parseFrontMatter("Text.\n\n---\ndraft: true\n---\n")).toBeNull();
	});
});
