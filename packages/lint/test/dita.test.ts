/**
 * Reading DITA, through the DITA Open Toolkit.
 *
 * Ported from `internal/lint/dita.go`. The toolkit is slow and rarely
 * installed, so what is testable without it is: the head is cut out of the
 * HTML it produces, the common directory a map run writes into is found, and
 * a missing toolkit is an error rather than a silent skip.
 */

import { describe, expect, test } from "bun:test";
import type { File } from "@vale-ts/core";
import { newConfig, newFile, newFlags, which } from "@vale-ts/core";
import { commonDir, type DITAHost, lintDITA, lintDITAHTML } from "../src/dita.ts";

const cfg = newConfig(newFlags({ ignoreGlobal: true }));

function host(): DITAHost & { html: string[] } {
	return {
		config: cfg,
		html: [],
		transform: (f: File) => f.content,
		lintHTMLTokens(_f, raw) {
			this.html.push(raw);
		},
	};
}

function file(content: string): File {
	const f = newFile(content, cfg);
	f.realExt = ".dita";
	f.normedExt = ".dita";
	f.path = "topic.dita";
	return f;
}

describe("lintDITAHTML", () => {
	test("the head is not prose", () => {
		const h = host();
		lintDITAHTML(
			h,
			file("<topic/>"),
			"<html><head><title>Not prose</title></head><body><p>Prose here.</p></body></html>",
		);
		expect(h.html[0]).toContain("<p>Prose here.</p>");
		expect(h.html[0]).not.toContain("Not prose");
	});

	test("a page with no head is kept whole", () => {
		const h = host();
		lintDITAHTML(h, file("<topic/>"), "<p>Prose here.</p>");
		expect(h.html[0]).toBe("<p>Prose here.</p>");
	});
});

describe("commonDir", () => {
	test("the deepest directory holding every path", () => {
		expect(commonDir(["/a/b/c/one.dita", "/a/b/d/two.dita"])).toBe("/a/b");
	});

	test("one directory is its own", () => {
		expect(commonDir(["/a/b/one.dita", "/a/b/two.dita"])).toBe("/a/b");
	});
});

const haveDITA = which(["dita", "dita.bat"]) !== "";

describe("without the toolkit", () => {
	const testIfMissing = haveDITA ? test.skip : test;

	testIfMissing("a missing toolkit is an error, not a silent skip", () => {
		expect(() => lintDITA(host(), file("<topic/>"))).toThrow(/dita not found/);
	});
});

if (haveDITA) {
	test.skip("the toolkit's own conversion belongs to the end-to-end suite", () => {});
}
