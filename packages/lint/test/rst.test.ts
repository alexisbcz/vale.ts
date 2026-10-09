/**
 * Reading reStructuredText.
 *
 * Ported from `internal/lint/rst_interp_test.go` and the parts of
 * `rst_pool_test.go` that are about the conversion rather than the process
 * pool. What can be tested without Docutils is tested without it; the cases
 * that need `rst2html` skip themselves when it is not installed, and
 * `test/external.md` says how to get it.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Config, File } from "@vale-ts/core";
import { newConfig, newFile, newFlags } from "@vale-ts/core";
import {
	convertRSTBatch,
	prepareRST,
	type RSTHost,
	rstBody,
	rstExe,
	rstInterpreter,
} from "../src/rst.ts";

const cfg: Config = newConfig(newFlags({ ignoreGlobal: true }));

/** A host that hands the document over unchanged and collects the HTML. */
function host(): RSTHost & { html: string[] } {
	return {
		config: cfg,
		html: [],
		transform: (f: File) => f.content,
		lintHTMLTokens(_f, raw) {
			this.html.push(raw);
		},
		lintMetadata: () => {},
	};
}

function file(content: string): File {
	return newFile(content, cfg);
}

describe("rstBody", () => {
	test("takes the document body out of a full page", () => {
		const page =
			"<html>\n<head><title>x</title></head>\n<body>\n<p>Prose here.</p>\n</body>\n</html>\n";
		expect(rstBody(page)).toBe("<p>Prose here.</p>");
	});

	test("a page with no body is kept whole", () => {
		expect(rstBody("<p>Prose here.</p>\n")).toBe("<p>Prose here.</p>");
	});

	test("carriage returns are dropped", () => {
		expect(rstBody("<body>\r\n<p>x</p>\r\n</body>")).not.toContain("\r");
	});
});

describe("prepareRST", () => {
	test("a Sphinx code directive becomes a literal block", () => {
		const got = prepareRST(host(), file(".. code-block:: python\n\n   import x\n"));
		expect(got).toContain("::\n");
		expect(got).not.toContain("code-block");
	});

	test("a directive's runtime options come off with it", () => {
		const got = prepareRST(
			host(),
			file(".. code-block:: python\n   :caption: A caption\n\n   import x\n"),
		);
		expect(got).not.toContain("caption");
	});

	test("a contents directive is read as code", () => {
		// It repeats the document's headings, which are prose somewhere else.
		// It becomes `.. code::`, which the code-directive rewrite then turns
		// into a plain literal block like any other.
		const got = prepareRST(host(), file(".. contents::\n\nProse here.\n"));
		expect(got).toBe("::\n\nProse here.\n");
	});

	test("a raw directive becomes a literal block", () => {
		const got = prepareRST(host(), file(".. raw:: html\n\n   <p>x</p>\n"));
		expect(got).not.toContain("raw::");
	});
});

/**
 * The interpreter is read out of a shebang, which is a claim the file makes
 * about itself rather than something Vale can verify. Anything but Python has
 * to come back empty: the caller's next move is to hand it the Docutils server
 * source, and a shell reads that as a script -- whose first line, `import
 * sys`, is a real program on a machine with ImageMagick. See #1137.
 *
 * Ported from `internal/lint/rst_interp_test.go`.
 */
describe("rstInterpreter", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "vale-rst-"));

	/** Writes an executable script and returns its path. */
	function script(name: string, body: string): string {
		const p = path.join(dir, name);
		writeFileSync(p, body, "utf8");
		chmodSync(p, 0o755);
		return p;
	}

	const cases: Array<[string, string, boolean]> = [
		[
			"pyenv shim",
			'#!/usr/bin/env bash\nset -e\nexec pyenv exec rst2html "$@"\n',
			false,
		],
		["sh wrapper", '#!/bin/sh\nexec /usr/bin/rst2html "$@"\n', false],
		["env perl", "#!/usr/bin/env perl\n", false],
		["env with no argument", "#!/usr/bin/env\n", false],
		["no shebang", "not a script\n", false],
		["empty file", "", false],
		["absolute python", "#!/usr/bin/python3\n", true],
		["versioned python", "#!/usr/local/bin/python3.12\n", true],
		["pypy", "#!/usr/bin/pypy3\n", true],
	];

	for (const [name, shebang, python] of cases) {
		test(name, () => {
			const got = rstInterpreter(
				script(`rst2html-${cases.length}-${name.replace(/\W+/g, "")}`, shebang),
			);
			if (!python) {
				expect(got).toBe("");
				return;
			}
			expect(path.basename(got)).toMatch(/^(?:python|pypy)[0-9.]*(?:\.exe)?$/i);
		});
	}

	test("a path that does not exist names no interpreter", () => {
		expect(rstInterpreter("/nonexistent/rst2html")).toBe("");
	});
});

/**
 * The conversion itself, which needs Docutils. The Sphinx handling is the
 * point: Docutils drops the body of a directive it does not know, so an
 * unknown one's prose would leave the document with it. See #294.
 */
const haveRST = rstExe() !== "";
const describeIfRST = haveRST ? describe : describe.skip;

describeIfRST("through Docutils (needs rst2html)", () => {
	test("prose survives the round trip", () => {
		const h = host();
		const html = convertRSTBatch(h, ["A paragraph of naïve prose.\n"]);
		expect(html).toHaveLength(1);
		expect(html[0]).toContain("naïve prose");
	});

	test("an unknown directive's body is prose", () => {
		const h = host();
		const [html] = convertRSTBatch(h, [
			".. versionadded:: 1.2\n\n   The body of an unknown directive.\n",
			"Another document.\n",
		]);
		expect(html).toContain("The body of an unknown directive.");
	});

	test("a code directive's body is not prose", () => {
		const h = host();
		const [html] = convertRSTBatch(h, [
			".. toctree::\n\n   not-prose\n",
			"Another document.\n",
		]);
		expect(html).not.toContain("<p>not-prose</p>");
	});

	test("a prose role's text is read, an identifier role's is not", () => {
		const h = host();
		const [html] = convertRSTBatch(h, [
			"See :term:`server-side rendering` and :py:func:`render_page`.\n",
			"Another document.\n",
		]);
		expect(html).toContain("server-side rendering");
		expect(html).toContain("<tt");
	});

	test("a batch comes back one document per request", () => {
		const h = host();
		const docs = ["First prose.\n", "Second prose.\n", "Third prose.\n"];
		const html = convertRSTBatch(h, docs);
		expect(html).toHaveLength(3);
		expect(html[0]).toContain("First prose.");
		expect(html[1]).toContain("Second prose.");
		expect(html[2]).toContain("Third prose.");
	});
});

if (!haveRST) {
	test.skip("rst2html is not installed; see test/external.md", () => {});
}
