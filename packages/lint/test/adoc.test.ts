/**
 * Reading AsciiDoc.
 *
 * Ported from the parts of `internal/lint/adoc_pool_test.go` that are about
 * the conversion rather than the process pool. The source rewriting needs no
 * Asciidoctor; the conversion skips itself when Asciidoctor is not installed,
 * and `test/external.md` says how to get it.
 */

import { describe, expect, test } from "bun:test";
import type { File } from "@vale-ts/core";
import { newConfig, newFile, newFlags, which } from "@vale-ts/core";
import { lintADoc, parseAttributes, prepADoc } from "../src/adoc.ts";

describe("parseAttributes", () => {
	test("YES and NO become the attribute and its negation", () => {
		expect(parseAttributes({ "source-highlighter": "rouge" })).toEqual([
			"-a",
			"source-highlighter=rouge",
		]);
		expect(parseAttributes({ experimental: "YES" })).toEqual([
			"-a",
			"experimental",
		]);
		expect(parseAttributes({ icons: "NO" })).toEqual(["-a", "icons!"]);
	});
});

describe("prepADoc", () => {
	/**
	 * A listing block's attributes name a language, so a rule looking for
	 * `ruby` would otherwise report the one in `[source,ruby]`. See #296.
	 */
	test("a listing block's attributes are masked", () => {
		const got = prepADoc("[source,ruby]\n----\nputs 1\n----\n");
		expect(got).not.toContain("ruby");
		expect(got.split("\n")[0].length).toBe("[source,ruby]".length);
	});

	test("a line comment is masked", () => {
		// The converter drops it, so a match found there has nowhere to live.
		const got = prepADoc("// A note about the thing.\n\nProse here.\n");
		expect(got).not.toContain("note about");
		expect(got).toContain("Prose here.");
		expect(got.length).toBe("// A note about the thing.\n\nProse here.\n".length);
	});

	test("nothing else moves", () => {
		const src = "= Title\n\nSome prose with `code` in it.\n";
		expect(prepADoc(src)).toBe(src);
	});
});

const cfg = newConfig(newFlags({ ignoreGlobal: true }));
const haveADoc = which(["asciidoctor"]) !== "";
const describeIfADoc = haveADoc ? describe : describe.skip;

describeIfADoc("through Asciidoctor (needs asciidoctor)", () => {
	function read(src: string): string {
		const f: File = newFile(src, cfg);
		f.realExt = ".adoc";
		f.normedExt = ".adoc";

		let html = "";
		lintADoc(
			{
				config: cfg,
				transform: (file) => file.content,
				lintHTMLTokens: (_file, raw) => {
					html = raw;
				},
				lintMetadata: () => {},
			},
			f,
		);
		return html;
	}

	test("prose survives the round trip, non-ASCII included", () => {
		expect(read("= T\n\nA naïve paragraph.\n")).toContain("naïve");
	});

	test("a section number is not authored prose", () => {
		// `sectnums` would prefix the heading with "1.", which appears nowhere
		// in the source. See #1101.
		const html = read(":sectnums:\n\n== A Heading\n\nProse here.\n");
		expect(html).toContain("A Heading");
		expect(html).not.toContain("1. A Heading");
	});

	test("a caption label is not authored prose", () => {
		// `table-caption` would write "Table 1." in front of the title. See
		// #1152.
		const html = read(".A Title\n|===\n| a\n|===\n");
		expect(html).not.toContain("Table 1.");
	});

	test("a smart apostrophe comes back as the entity a rule matches", () => {
		// Asciidoctor turns `'` into `’`; both forms are normalized. See #206.
		expect(read("= T\n\nIt's here.\n")).not.toContain("’");
	});
});

if (!haveADoc) {
	test.skip("asciidoctor is not installed; see test/external.md", () => {});
}
