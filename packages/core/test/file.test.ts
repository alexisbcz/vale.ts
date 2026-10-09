/**
 * A file being linted: which sections apply to it, which rules they turn on,
 * where an alert lands, and which comment directives suppress it.
 *
 * Ported from `internal/core/file_test.go` and `internal/core/addalert_test.go`.
 * `TestSentenceLengthSD` lives in the Go file test but measures `metrics.go`,
 * so it stays with its Go neighbours here too.
 *
 * The configurations are built with `--no-global` so that nothing on the
 * machine's default styles path takes part.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { newDocument } from "@vale-ts/nlp";
import { newAlert } from "../src/alert.ts";
import { Block } from "../src/block.ts";
import { fromString, newConfig, newFlags } from "../src/config.ts";
import { File, newFile } from "../src/file.ts";
import { Glob } from "../src/glob.ts";
import { sentenceLengthSD } from "../src/metrics.ts";

function tempDir(): string {
	return mkdtempSync(nodePath.join(tmpdir(), "vale-file-"));
}

function write(path: string, body: string): string {
	mkdirSync(nodePath.dirname(path), { recursive: true });
	writeFileSync(path, body);
	return path;
}

/**
 * When several configuration sections match the same file, `newFile` resolves
 * `lang` and `transform` by taking the LAST matching section in the order it
 * was written -- the same "later one wins" semantics the rule/level resolution
 * loop documents for #965 -- rather than depending on the order a map happens
 * to be walked in.
 */
test("the last matching section wins", () => {
	const sections = [
		{ name: "*.md", lang: "en", xslt: "one.xsl" },
		{ name: "*.md", lang: "fr", xslt: "two.xsl" },
		{ name: "*.md", lang: "de", xslt: "three.xsl" },
		{ name: "*.md", lang: "ja", xslt: "four.xsl" },
		{ name: "*.md", lang: "es", xslt: "five.xsl" },
		{ name: "*.md", lang: "it", xslt: "six.xsl" },
	];

	const cfg = newConfig(newFlags({ ignoreGlobal: true }));

	for (const [i, s] of sections.entries()) {
		// Reuse the same glob pattern across sections, but track each
		// occurrence under its own key so every one can carry its own
		// lang/transform value -- mirroring how repeated real config sections
		// (several `[*.md]` blocks, say) are keyed internally.
		const key = i > 0 ? s.name + String.fromCharCode(97 + i) : s.name;

		cfg.secToPat[key] = Glob.compile(s.name);
		cfg.ruleKeys.push(key);
		cfg.formatToLang[key] = s.lang;
		cfg.stylesheets[key] = s.xslt;
		cfg.sChecks[key] = {};
		cfg.sLevels[key] = {};
	}

	const last = sections[sections.length - 1]!;
	const docPath = write(nodePath.join(tempDir(), "doc.md"), "# Title\n");

	// Go repeats this 50 times because its map iteration order is randomized;
	// the port walks `ruleKeys`, which is written order, so once is enough --
	// the loop stays as a guard against a resolution that reads a map again.
	for (let i = 0; i < 50; i++) {
		const f = newFile(docPath, cfg);
		expect(f.nlp.lang, `iteration ${i}`).toBe(last.lang);
		expect(f.transform, `iteration ${i}`).toBe(last.xslt);
	}
});

// The `[*] Lang = ...` global default still applies when no format-specific
// section matches the file.
test("a global Lang is the fallback", () => {
	const cfg = newConfig(newFlags({ ignoreGlobal: true }));
	cfg.formatToLang["*"] = "ja";

	const docPath = write(nodePath.join(tempDir(), "doc.txt"), "hello\n");

	expect(newFile(docPath, cfg).nlp.lang).toBe("ja");
});

/**
 * The position-aware half of comment handling: a directive whose offset is
 * known records a region, and a located alert inside it is suppressed -- by
 * its own name, its style, or a match key -- while one before the NO, after
 * the YES, or from another check is not.
 */
test("a comment directive suppresses the region it covers", () => {
	const f = new File();
	f.setText(
		"one\ntwo <!-- vale T.Rule = NO -->\nthree\n<!-- vale T.Rule = YES --> four\n",
	);

	const noAt = "one\ntwo <!-- ".length;
	const yesAt = "one\ntwo <!-- vale T.Rule = NO -->\nthree\n<!-- ".length;

	f.updateCommentsAt("vale T.Rule = NO", noAt);
	f.updateCommentsAt("vale T.Rule = YES", yesAt);

	expect(f.regionDisabled("T.Rule", "", 1, 1), "before the NO").toBe(false);
	expect(f.regionDisabled("T.Rule", "", 3, 1), "inside the region").toBe(true);
	expect(f.regionDisabled("T.Rule", "", 4, 30), "after the YES").toBe(false);
	expect(f.regionDisabled("T.Other", "", 3, 1), "another rule").toBe(false);

	// A style-level directive covers every rule in the style, and an unclosed
	// region runs to the end of the file.
	f.updateCommentsAt("vale T = NO", yesAt + 40);
	expect(f.regionDisabled("T.Other", "", 99, 1), "style-level region").toBe(true);

	// An unknown position records nothing.
	const g = new File();
	g.setText("text\n");
	g.updateCommentsAt("vale T.Rule = NO", -1);
	expect(g.regionDisabled("T.Rule", "", 1, 1)).toBe(false);
});

// An empty `BasedOnStyles` resets what a file inherited, its own keys still
// apply after it, and UNSET drops one inherited key.
test("an empty BasedOnStyles resets, and UNSET drops a key", () => {
	const root = tempDir();
	const ini = `StylesPath = ${root}\n\n${[
		"[*]",
		"Google.Semicolons = warning",
		"Vale.Spelling = NO",
		"",
		"[*.md]",
		"BasedOnStyles = Google",
		"Google.Colons = NO",
		"",
		"[**/docs/*.md]",
		"BasedOnStyles =",
		"Google.Headings = YES",
		"",
		"[**/api/*.md]",
		"Google.Colons = UNSET",
		"",
	].join("\n")}`;

	const cfg = newConfig(newFlags({ ignoreGlobal: true }));
	fromString(ini, cfg, false);

	const open = (dir: string): File => {
		const path = write(nodePath.join(root, dir, "page.md"), "Hello.\n");
		return newFile(path, cfg);
	};

	const other = open("other");
	expect(other.baseStyles, "other").toEqual(["Google"]);
	expect(other.checks["Google.Colons"], "other").toBe(false);

	const docs = open("docs");
	expect(docs.baseStyles, "docs").toEqual([]);
	for (const k of ["Google.Semicolons", "Vale.Spelling"]) {
		// The global setting is turned off, not inherited.
		expect(docs.checks[k], `docs: ${k}`).toBe(false);
	}
	expect(
		"Google.Colons" in docs.checks,
		"docs: inherited past an empty BasedOnStyles",
	).toBe(false);
	// Set after the reset, so it still applies.
	expect(docs.checks["Google.Headings"], "docs").toBe(true);

	const api = open("api");
	expect("Google.Colons" in api.checks, "api: survived UNSET").toBe(false);
	expect(api.unset["Google.Colons"], "api: marked unset").toBe(true);
	expect(api.baseStyles, "api").toEqual(["Google"]);
});

describe("addAlert", () => {
	/** A file with the per-block alert state a check would find. */
	function blankFile(): File {
		const f = new File();
		f.startBlock();
		return f;
	}

	// `addAlert` must not panic on an alert with a negative span -- spelling
	// can produce one when the matched token isn't found verbatim in the block.
	// See #808 (panic: slice bounds out of range [-1:]).
	test("a negative span is survivable", () => {
		const f = blankFile();
		// The match occurs more than once in a short context, which is the
		// disambiguation branch that previously sliced ctx[0:span[0]] with a
		// negative index.
		const blk = new Block("word and word", "word and word", "text.md");
		const a = newAlert({ check: "X", match: "word", span: [-1, 3] });

		expect(() => f.addAlert(a, blk, 1, 0, false)).not.toThrow();
	});

	// An anchored empty match is a location, not a measurement: it keeps its
	// column rather than falling back to the start of its block.
	test("an anchored empty match keeps its column", () => {
		const f = blankFile();
		f.setText("# Title\n\nAdd a thing\n");

		const blk = new Block(f.content, "Add a thing", "text.md", 2);
		const a = newAlert({
			check: "X",
			match: "",
			span: [14, 14],
			hasByteOffsets: true,
		});

		f.addAlert(a, blk, 3, 0, false);

		expect(f.alerts).toHaveLength(1);
		expect([f.alerts[0]!.line, f.alerts[0]!.span]).toEqual([3, [6, 6]]);
	});

	// A measurement still lands at the start of its block.
	test("a measurement starts at its block", () => {
		const f = blankFile();
		f.setText("# Title\n\nAdd a thing\n");

		const blk = new Block(f.content, "Add a thing", "text.md", 2);
		const a = newAlert({ check: "X", match: "", span: [1, 1] });

		f.addAlert(a, blk, 3, 0, false);

		expect(f.alerts).toHaveLength(1);
		expect([f.alerts[0]!.line, f.alerts[0]!.span]).toEqual([3, [1, 1]]);
	});
});

describe("level", () => {
	// A file reports a rule at the level its own sections gave it, falling back
	// to the level the rule was compiled with.
	const f = new File();
	f.levels = { "Vale.Spelling": "warning", proselint: "suggestion" };

	const cases: Array<{
		name: string;
		rule: string;
		compiled: string;
		want: string;
	}> = [
		{
			name: "the rule itself",
			rule: "Vale.Spelling",
			compiled: "error",
			want: "warning",
		},
		{
			name: "its style",
			rule: "proselint.Typography",
			compiled: "error",
			want: "suggestion",
		},
		{
			name: "neither",
			rule: "Microsoft.Wordiness",
			compiled: "error",
			want: "error",
		},
	];

	test.each(cases)("$name", ({ rule, compiled, want }) => {
		expect(f.level(rule, compiled)).toBe(want);
	});
});

describe("sentenceLengthSD", () => {
	test("measures how much the sentences vary in length", () => {
		expect(
			sentenceLengthSD(newDocument("One two three. One two three. One two three.")),
		).toBe(0);
		expect(
			sentenceLengthSD(
				newDocument("Short. This one is a good deal longer than that."),
			),
		).toBeGreaterThan(0);
		expect(sentenceLengthSD(newDocument(""))).toBe(0);
	});
});
