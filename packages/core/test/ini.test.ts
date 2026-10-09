/**
 * Reading a `.vale.ini` into a `Config`.
 *
 * Ported from `internal/core/ini_test.go`. Go's tests call the unexported
 * `shadowLoad` and then `processConfig(uCfg, cfg, false)`:
 *
 *  - one source is `fromString(src, cfg, false)` here, which is the same pair
 *    of calls;
 *  - several sources go through `loadLayers`, which writes them to disk and
 *    names them in `flags.sources` -- the path a package's configuration takes,
 *    and the only way to stack sources with `dry` off.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
	asRuleParam,
	type Config,
	fromFile,
	fromString,
	newConfig,
	newFlags,
} from "../src/config.ts";
import { setWarnSink, type WarnSink } from "../src/errors.ts";

let warnings: string[] = [];
let restore: WarnSink;

beforeEach(() => {
	warnings = [];
	restore = setWarnSink((msg) => warnings.push(msg));
});

afterEach(() => {
	setWarnSink(restore);
});

function config(): Config {
	return newConfig(newFlags({ ignoreGlobal: true }));
}

/**
 * Loads several sources into `cfg`, earliest first, the way a package's
 * configuration and the project's stack up.
 */
function loadLayers(cfg: Config, ...texts: string[]): void {
	const dir = mkdtempSync(nodePath.join(tmpdir(), "vale-ini-"));
	const paths = texts.map((text, i) => {
		const path = nodePath.join(dir, `${i}.ini`);
		writeFileSync(path, text);
		return path;
	});

	cfg.flags.sources = paths.join(",");
	for (const path of paths) cfg.addConfigFile(path);
	fromFile(cfg, false);
}

describe("CommentDelimiters", () => {
	test("custom comment delimiters for markdown", () => {
		const cfg = config();
		fromString('[*.md]\nCommentDelimiters = "{/*,*/}"\n', cfg, false);
		expect(cfg.commentDelimiters["*.md"]).toEqual(["{/*", "*/}"]);
	});

	test("not set", () => {
		const cfg = config();
		fromString("[*.md]\nTokenIgnores = (\\$+[^\\n$]+\\$+)\n", cfg, false);
		expect(cfg.commentDelimiters).toEqual({});
	});

	const errors: Array<{ description: string; body: string; expected: string }> = [
		{
			description: "global custom comment delimiters",
			body: '[*]\nCommentDelimiters = "{/*,*/}"\n',
			expected: "syntax-specific option",
		},
		{
			description: "more than two delimiters",
			body: '[*.md]\nCommentDelimiters = "{/*,*/},<<,>>"\n',
			expected:
				"CommentDelimiters must be a comma-separated list of two delimiters, but got 4 items",
		},
		{
			description: "more than two delimiters (shadow)",
			body: '[*.md]\nCommentDelimiters = "{/*,*/}"\n\n[*.md]\nCommentDelimiters = "<<,>>"\n',
			expected:
				"CommentDelimiters must be a comma-separated list of two delimiters, but got 4 items",
		},
		{
			description: "one delimiter is empty",
			body: '[*.md]\nCommentDelimiters = "{/*"\n',
			expected:
				"CommentDelimiters must be a comma-separated list of two delimiters, but got 1 items",
		},
	];

	test.each(errors)("$description", ({ body, expected }) => {
		expect(() => fromString(body, config(), false)).toThrow(expected);
	});
});

describe("Transform", () => {
	// `determinePath` joins a relative value onto the configuration file's
	// directory, so a stylesheet beside a `.vale.ini` is found whatever
	// directory Vale ran from.
	test("a relative path resolves against the config file", () => {
		const cfg = config();
		const projectDir = nodePath.resolve(nodePath.join("Source", "project"));
		cfg.addConfigFile(nodePath.join(projectDir, ".vale.ini"));

		fromString("[*.xml]\nTransform = transform.xsl\n", cfg, false);

		expect(cfg.stylesheets["*.xml"]).toBe(
			nodePath.join(projectDir, "transform.xsl"),
		);
	});

	test("an absolute path is kept", () => {
		const cfg = config();
		const absolute = nodePath.resolve("transform.xsl");
		const projectDir = nodePath.resolve(nodePath.join("Source", "project"));
		cfg.addConfigFile(nodePath.join(projectDir, ".vale.ini"));

		fromString(`[*.xml]\nTransform = ${absolute}\n`, cfg, false);

		expect(nodePath.normalize(cfg.stylesheets["*.xml"]!)).toBe(
			nodePath.normalize(absolute),
		);
	});
});

/**
 * A config split across two sources, which is the ordinary case: a global
 * `.vale.ini` plus the project's.
 *
 * Sections here are glob patterns, and nearly all of them contain a dot. The
 * ini library reads a dot as section nesting, so a key lookup that missed in
 * `[*.txt]` used to fall back to `[*]` and return its key. Merging the second
 * source then wrote one section's styles into the other, and a style scoped to
 * `.txt` applied to every file. See #1129.
 */
test("sections do not inherit from one another", () => {
	const cfg = config();
	loadLayers(
		cfg,
		"MinAlertLevel = suggestion\n",
		"[*]\nBasedOnStyles = A\n\n[*.txt]\nBasedOnStyles = B\n",
	);

	expect(cfg.gBaseStyles, "[*] should hold only its own styles").toEqual(["A"]);
	expect(cfg.sBaseStyles["*.txt"], "[*.txt] should hold only its own").toEqual([
		"B",
	]);
});

/**
 * A level set under a section belongs to that section. Collecting them all in
 * one map let the last section in the file decide the level everywhere. See
 * #965.
 */
describe("section levels", () => {
	const cases: Array<{
		description: string;
		body: string;
		levels: Record<string, Record<string, string>>;
		global: Record<string, string>;
	}> = [
		{
			description: "one section overrides a shared style",
			body: "[*.{html,md}]\nBasedOnStyles = Vale\n\n[*.md]\nVale.Spelling = warning\n",
			levels: {
				"*.{html,md}": {},
				"*.md": { "Vale.Spelling": "warning" },
			},
			global: {},
		},
		{
			description: "each section keeps its own level",
			body: "[*.html]\nVale.Spelling = error\n\n[*.md]\nVale.Spelling = warning\n",
			levels: {
				"*.html": { "Vale.Spelling": "error" },
				"*.md": { "Vale.Spelling": "warning" },
			},
			global: {},
		},
		{
			description: "a level under [*] stays global",
			body: "[*]\nVale.Spelling = suggestion\n\n[*.md]\nBasedOnStyles = Vale\n",
			levels: { "*.md": {} },
			global: { "Vale.Spelling": "suggestion" },
		},
		{
			description: "YES and NO carry no level",
			body: "[*.md]\nVale.Spelling = YES\nVale.Repetition = NO\n",
			levels: { "*.md": {} },
			global: {},
		},
	];

	test.each(cases)("$description", ({ body, levels, global }) => {
		const cfg = config();
		fromString(body, cfg, false);

		for (const [sec, want] of Object.entries(levels)) {
			expect(cfg.sLevels[sec], sec).toEqual(want);
		}
		expect(cfg.ruleToLevel).toEqual(global);
	});
});

// Go's `TestFileLevel` sits in this file; it asks `File.level` which level a
// rule reports at, so it is in `file.test.ts` here.

/**
 * `Style.Rule[param]` is the php.ini-style parameter key; anything else is
 * left for the level/toggle path, and structural fields are refused with a
 * pointer at inheritance.
 */
describe("asRuleParam", () => {
	const cases: Array<{ key: string; val: string; isParam: boolean }> = [
		{ key: "Std.SentenceLength[max]", val: "30", isParam: true },
		{ key: "Std.dates.TimeFormat[ignorecase]", val: "true", isParam: true },
		{ key: "Std.SentenceLength", val: "error", isParam: false },
		{ key: "BasedOnStyles", val: "Std", isParam: false },
		{ key: "NoDot[max]", val: "1", isParam: false },
	];

	test("tells a parameter key from the rest", () => {
		const cfg = config();
		for (const tt of cases) {
			expect(asRuleParam(tt.key, tt.val, cfg), tt.key).toBe(tt.isParam);
		}
		expect(cfg.ruleToParams["Std.SentenceLength"]?.max).toBe("30");
	});

	test("refuses a structural parameter with the extend guidance", () => {
		expect(() => asRuleParam("Std.Passive[tokens]", "x", config())).toThrow(
			"extend",
		);
	});

	// One spelling per setting: the classic key owns levels.
	test("refuses a bracketed level, pointing at the classic key", () => {
		expect(() => asRuleParam("S.R[level]", "error", config())).toThrow(
			"S.R = error",
		);
	});

	/**
	 * A later *configuration* wins -- package fragments and the local ini load
	 * sequentially, each calling this once per key. Within one file the ini
	 * library collapses duplicate keys to the first before this layer runs.
	 */
	test("a later value wins", () => {
		const cfg = config();
		asRuleParam("S.R[max]", "10", cfg);
		asRuleParam("S.R[max]", "20", cfg);
		expect(cfg.ruleToParams["S.R"]?.max).toBe("20");
	});
});

// An escaped comma stays inside its pattern; a bare one still separates
// patterns. See #1164.
test("the ignore keys keep an escaped comma", () => {
	const cfg = config();
	fromString(
		[
			"[*]",
			String.raw`TokenIgnores = \b[a-z]{2\,}\b, (\$+[^\n$]+\$+)`,
			String.raw`BlockIgnores = BEGIN.{2\,}END`,
			String.raw`TokenIgnores = \\, \d{1\,3}`,
			"",
			"[*.md]",
			String.raw`TokenIgnores = \b[a-z]{2\,}\b`,
			String.raw`BlockIgnores = BEGIN.{2\,}END, (?s)<!--.*?-->`,
			"",
		].join("\n"),
		cfg,
		false,
	);

	expect(cfg.tokenIgnores["*"], "global TokenIgnores").toEqual([
		String.raw`\b[a-z]{2,}\b`,
		String.raw`(\$+[^\n$]+\$+)`,
		String.raw`\\`,
		String.raw`\d{1,3}`,
	]);
	expect(cfg.blockIgnores["*"], "global BlockIgnores").toEqual([
		String.raw`BEGIN.{2,}END`,
	]);
	expect(cfg.tokenIgnores["*.md"], "section TokenIgnores").toEqual([
		String.raw`\b[a-z]{2,}\b`,
	]);
	expect(cfg.blockIgnores["*.md"], "section BlockIgnores").toEqual([
		String.raw`BEGIN.{2,}END`,
		String.raw`(?s)<!--.*?-->`,
	]);
});

// A package's configuration is read before the project's, and a key both set
// takes the project's value: the later source wins, for a level, a parameter,
// and a switch alike.
test("a later source wins", () => {
	const cfg = config();
	loadLayers(
		cfg,
		"[*]\nS.G = error\n\n[*.md]\nS.R = error\nS.R[max] = 10\n",
		"[*]\nS.G = NO\n\n[*.md]\nS.R = suggestion\nS.R[max] = 20\n",
	);

	expect(cfg.sLevels["*.md"]?.["S.R"], "level").toBe("suggestion");
	expect(cfg.ruleToParams["S.R"]?.max, "param").toBe("20");
	expect(cfg.gChecks["S.G"], "the project switched it off").toBe(false);
});

// A `[sphinx]` section is kept for the reStructuredText and MyST readers, and
// a key it doesn't define is dropped with a warning rather than passed along.
test("a sphinx section is kept and is not a file glob", () => {
	const cfg = config();
	fromString(
		[
			"[sphinx]",
			"CodeDirectives = mermaid, plantuml",
			"ProseRoles = kbd",
			"Unknown = x",
			"",
			"[*.rst]",
			"BasedOnStyles = Vale",
			"",
		].join("\n"),
		cfg,
		false,
	);

	expect(cfg.sphinx).toEqual({
		CodeDirectives: "mermaid, plantuml",
		ProseRoles: "kbd",
	});
	expect("sphinx" in cfg.secToPat, "compiled as a file glob").toBe(false);
	expect(warnings.join("\n")).toContain("isn't a sphinx option");
});

// `NONE` reads as an empty `BasedOnStyles`. Its values arrive merged across
// layers, so NONE clears the layers before it.
describe("BasedOnStyles = NONE", () => {
	const cases: Array<{
		desc: string;
		layers: string[];
		global: string[];
		local: string[];
	}> = [
		{
			desc: "NONE alone",
			layers: ["[*]\nBasedOnStyles = NONE\n\n[*.md]\nBasedOnStyles = NONE\n"],
			global: [],
			local: [],
		},
		{
			desc: "a later layer's NONE clears an earlier one's styles",
			layers: ["[*.md]\nBasedOnStyles = Vale\n", "[*.md]\nBasedOnStyles = NONE\n"],
			global: [],
			local: [],
		},
		{
			desc: "a later layer's styles follow an earlier NONE",
			layers: ["[*.md]\nBasedOnStyles = NONE\n", "[*.md]\nBasedOnStyles = House\n"],
			global: [],
			local: ["House"],
		},
	];

	test.each(cases)("$desc", ({ layers, global, local }) => {
		const cfg = config();
		if (layers.length === 1) fromString(layers[0]!, cfg, false);
		else loadLayers(cfg, ...layers);

		expect(cfg.gBaseStyles, "[*]").toEqual(global);
		expect("*.md" in cfg.sBaseStyles, "[*.md] declared").toBe(true);
		expect(cfg.sBaseStyles["*.md"], "[*.md]").toEqual(local);
	});
});
