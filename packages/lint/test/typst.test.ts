/**
 * Reading Typst, through `typst2vast`.
 *
 * Ported from `internal/lint/typst.go`. The converter is rarely installed, so
 * what is testable without it is that a missing one is an error naming it
 * rather than a document read as plain text.
 */

import { describe, expect, test } from "bun:test";
import type { File } from "@vale-ts/core";
import { newConfig, newFile, newFlags, which } from "@vale-ts/core";
import { lintTypst, type TypstHost } from "../src/typst.ts";

const cfg = newConfig(newFlags({ ignoreGlobal: true }));

function host(): TypstHost & { html: string[] } {
	return {
		html: [],
		transform: (f: File) => f.content,
		lintHTMLTokens(_f, raw) {
			this.html.push(raw);
		},
		lintMetadata: () => {},
	};
}

function file(content: string): File {
	const f = newFile(content, cfg);
	f.realExt = ".typ";
	f.normedExt = ".typ";
	f.path = "doc.typ";
	return f;
}

const haveTypst = which(["typst2vast"]) !== "";

describe("lintTypst", () => {
	const testIfMissing = haveTypst ? test.skip : test;

	testIfMissing("a missing converter is an error, not a silent skip", () => {
		expect(() => lintTypst(host(), file("= A heading\n"))).toThrow(
			/typst2vast not found/,
		);
	});

	const testIfPresent = haveTypst ? test : test.skip;

	testIfPresent("prose survives the round trip", () => {
		const h = host();
		lintTypst(h, file("= A naïve heading\n\nSome prose.\n"));
		expect(h.html.join("")).toContain("naïve heading");
		expect(h.html.join("")).toContain("Some prose.");
	});
});
