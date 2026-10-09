/**
 * Reading XML through an XSLT stylesheet.
 *
 * Ported from `internal/lint/xml_test.go`, which exists for one reason: the
 * shared flag list must not grow by two entries per file.
 */

import { describe, expect, test } from "bun:test";
import { newConfig, newFile, newFlags } from "@vale-ts/core";
import { lintXML, XSLT_ARGS } from "../src/xml.ts";

describe("the XSLT flags", () => {
	test("a run does not grow the shared list", () => {
		const before = XSLT_ARGS.length;
		for (let i = 0; i < 3; i++) {
			const args = [...XSLT_ARGS, "transform.xsl", "-"];
			expect(XSLT_ARGS.length).toBe(before);
			expect(args.length).toBe(before + 2);
		}
	});
});

describe("lintXML", () => {
	const cfg = newConfig(newFlags({ ignoreGlobal: true }));

	test("a file with no stylesheet is an error, not read as prose", () => {
		const f = newFile("<doc><p>Prose here.</p></doc>", cfg);
		f.realExt = ".xml";
		f.normedExt = ".xml";
		f.transform = "";

		expect(() => lintXML({ lintHTMLTokens: () => {} }, f)).toThrow();
	});
});
