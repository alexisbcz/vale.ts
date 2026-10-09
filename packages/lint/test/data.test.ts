/**
 * Reading a data file through a view, and the two readings that come for free.
 *
 * Ported from `internal/lint/data.go` and `code_test.go`. The cases that drive
 * the whole linter belong to the end-to-end compatibility suite; what is here
 * is what can be asked of these functions on their own.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { Block, Config, File, ScopedValues } from "@vale-ts/core";
import { newConfig, newFile, newFlags, View } from "@vale-ts/core";
import { initCode } from "../src/code/index.ts";
import { maskURLs, skipsComment, updateQueries } from "../src/code.ts";
import {
	type DataHost,
	hasCodeView,
	hasView,
	isRuleFile,
	lintDataComments,
	lintRule,
} from "../src/data.ts";

beforeAll(async () => {
	await initCode();
});

function config(): Config {
	return newConfig(newFlags({ ignoreGlobal: true }));
}

/** A host that records the text and the values it is handed. */
function host(cfg: Config): DataHost & {
	read: string[];
	blocks: Block[];
	values: ScopedValues[][];
} {
	return {
		config: cfg,
		read: [],
		blocks: [],
		values: [],
		transform: (f: File) => f.content,
		lintHTMLTokens: () => {},
		lintMetadata: () => {},
		lintLines(f) {
			this.read.push(f.content);
		},
		lintBlock(_f, blk) {
			this.blocks.push(blk);
			this.read.push(blk.text);
		},
		lintSummary: () => {},
		readAs: () => {},
		lintScopedValues(_f, values) {
			this.values.push([...values]);
		},
	};
}

/**
 * A file with the extension and the path a section would match.
 *
 * The content is the document: `newFile` reads a path when one exists and the
 * text itself otherwise, so the path is set afterwards.
 */
function file(cfg: Config, content: string, ext: string): File {
	const f = newFile(content, cfg);
	f.realExt = ext;
	f.normedExt = ext;
	f.path = `doc${ext}`;
	return f;
}

/**
 * Both readers of a source file consult `skipsComment`, so a scope excluded
 * from one is excluded from the other. Mapping a markup format onto a file
 * switches which reader runs, and used to switch this off with it. See #858.
 */
describe("skipsComment", () => {
	const cases: Array<[string, string[], string, boolean]> = [
		["nothing ignored", [], "text.comment.block", false],
		["the scope itself", ["text.comment.block"], "text.comment.block", true],
		["every comment", ["comment"], "text.comment.block", true],
		["a different scope", ["text.comment.line"], "text.comment.block", false],
		[
			"alongside the defaults",
			["code", "tt", "text.comment.block"],
			"text.comment.block",
			true,
		],
	];

	for (const [name, ignored, scope, want] of cases) {
		test(name, () => {
			const cfg = config();
			cfg.ignoredScopes = ignored;
			expect(skipsComment(cfg, scope)).toBe(want);
		});
	}
});

describe("isRuleFile", () => {
	const cfg = config();

	test("a YAML file with a top-level extends", () => {
		expect(
			isRuleFile(file(cfg, "extends: existence\nmessage: '%s'\n", ".yml")),
		).toBe(true);
	});

	test("an indented extends is not one", () => {
		expect(isRuleFile(file(cfg, "a:\n  extends: existence\n", ".yml"))).toBe(false);
	});

	test("another format is not one", () => {
		expect(isRuleFile(file(cfg, "extends: existence\n", ".json"))).toBe(false);
	});
});

/**
 * A rule's message and description are prose; its tokens, swaps and
 * exceptions are patterns, and often wrong on purpose.
 */
describe("lintRule", () => {
	test("the message and the description are the only values", () => {
		const cfg = config();
		const h = host(cfg);
		const f = file(
			cfg,
			"extends: existence\nmessage: \"'%s' is a misteak\"\ndescription: A longer explanashun.\ntokens:\n  - misteak\n",
			".yml",
		);

		lintRule(h, f);

		expect(h.values).toHaveLength(1);
		const texts = h.values[0].flatMap((v) => v.values.map((sv) => sv.text));
		expect(texts).toEqual(["'%s' is a misteak", "A longer explanashun."]);
	});

	test("a rule with neither field is not read", () => {
		const cfg = config();
		const h = host(cfg);
		lintRule(h, file(cfg, "extends: existence\ntokens:\n  - a\n", ".yml"));
		expect(h.values).toHaveLength(0);
	});

	// `yaml.v3` lets a duplicate key's last value win, and one of the styles
	// in Vale's own corpus has a repeated term.
	test("a duplicate key is read as Vale reads it", () => {
		const cfg = config();
		const h = host(cfg);
		lintRule(
			h,
			file(
				cfg,
				"extends: substitution\nmessage: \"Use '%s'\"\nswap:\n  Bronte: Brontë\n  Bronte: Brontë\n",
				".yml",
			),
		);
		expect(h.values).toHaveLength(1);
	});

	test("a file this cannot parse is not a rule to lint", () => {
		const cfg = config();
		const h = host(cfg);
		lintRule(h, file(cfg, "extends: existence\nmessage: [unclosed\n", ".yml"));
		expect(h.values).toHaveLength(0);
	});
});

describe("which engine reads the file", () => {
	function withView(engine: string, expr: string): Config {
		const cfg = config();
		cfg.views["*.yml"] = new View({
			engine,
			scopes: [{ name: "x", expr, type: "" }],
		});
		return cfg;
	}

	test("a dasel view is not a tree-sitter one", () => {
		const cfg = withView("dasel", "a.b");
		const f = file(cfg, "a:\n  b: prose\n", ".yml");
		expect(hasView(cfg, f)).toBe(true);
		expect(hasCodeView(cfg, f)).toBe(false);
	});

	test("a tree-sitter view is not a data one", () => {
		const cfg = withView("tree-sitter", "(comment) @comment");
		const f = file(cfg, "# A note.\n", ".yml");
		expect(hasView(cfg, f)).toBe(false);
		expect(hasCodeView(cfg, f)).toBe(true);
	});

	test("a tree-sitter view's queries replace the language's own", () => {
		const cfg = withView("tree-sitter", "(comment) @comment");
		const f = file(cfg, "# A note.\n", ".yml");
		expect(updateQueries(f, cfg)).toHaveLength(1);
		expect(updateQueries(f, config())).toHaveLength(0);
	});
});

/**
 * A data file's comments are prose whatever its view selects, and a `#`
 * inside a string is not a comment.
 */
describe("lintDataComments", () => {
	test("a YAML file's comments are read, its strings are not", () => {
		const cfg = config();
		const h = host(cfg);
		lintDataComments(
			h,
			file(
				cfg,
				'# The defalt settings.\ntitle: A guide\nslug: "not # a commnt"  # A trailng one.\n',
				".yml",
			),
		);

		const read = h.read.join("\n");
		expect(read).toContain("The defalt settings.");
		expect(read).toContain("A trailng one.");
		expect(read).not.toContain("a commnt");
	});

	test("a format with no comments to read does nothing", () => {
		const cfg = config();
		const h = host(cfg);
		lintDataComments(h, file(cfg, '{"a": "b"}', ".json"));
		expect(h.read).toHaveLength(0);
	});
});

/**
 * A URL is never prose, and in markup the converter keeps one out of the text
 * already.
 */
describe("maskURLs", () => {
	test("a URL is blanked, its width kept", () => {
		const got = maskURLs("See https://example.com/a_b for details.");
		expect(got).toBe("See                         for details.");
	});

	test("the punctuation that closes the sentence is kept", () => {
		expect(maskURLs("See https://example.com.")).toBe("See                    .");
	});

	test("prose with no URL is untouched", () => {
		expect(maskURLs("No link here.")).toBe("No link here.");
	});
});
