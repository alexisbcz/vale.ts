/**
 * End-to-end tests of the assembled library.
 *
 * Each builds a small project in a temporary directory -- a `.vale.ini`, a
 * style, a document -- and checks what comes back. That is the shape most
 * callers use, and it is the only level at which a mistake in how the packages
 * fit together shows up.
 *
 * Breadth of *behavior* is the compatibility suite's job, with 367 of Vale's
 * own cases; what these cover is the API itself, and one case per rule type as
 * a sanity check that each is wired up at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Vale } from "../src/index.ts";

let dir = "";
let cwd = "";

beforeEach(() => {
	cwd = process.cwd();
	dir = mkdtempSync(path.join(tmpdir(), "vale-ts-test-"));
	process.chdir(dir);
});

afterEach(() => {
	process.chdir(cwd);
	rmSync(dir, { recursive: true, force: true });
});

/** Writes a file, creating the directories it needs. */
function write(name: string, body: string): void {
	const full = path.join(dir, name);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, body);
}

/** A project with one rule in a style called `T`. */
function project(rule: string, ini = "[*.md]\nBasedOnStyles = T\n"): void {
	write(".vale.ini", `StylesPath = styles\nMinAlertLevel = suggestion\n\n${ini}`);
	write("styles/T/Rule.yml", rule);
}

/** Every alert, as `line:column:check:message`. */
async function lint(file: string): Promise<string[]> {
	const vale = await Vale.fromConfig({ ignoreGlobal: true });
	const out: string[] = [];
	for (const linted of vale.lintFile(file)) {
		for (const a of linted.sortedAlerts()) {
			out.push(`${a.line}:${a.span[0]}:${a.check}:${a.message}`);
		}
	}
	return out;
}

describe("the library's surface", () => {
	test("a configuration can come from a string", async () => {
		write(
			"styles/T/Rule.yml",
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("doc.md", "We utilize it.\n");

		const vale = await Vale.fromString(
			"StylesPath = styles\nMinAlertLevel = suggestion\n\n[*.md]\nBasedOnStyles = T\n",
			{ ignoreGlobal: true },
		);
		const alerts = vale.lintFile("doc.md").flatMap((f) => f.sortedAlerts());
		expect(alerts.map((a) => a.message)).toEqual(["found 'utilize'"]);
	});

	test("a string is linted as the path it claims to be", async () => {
		// Which rules apply depends on the path, so an editor buffer has to be
		// able to say what it is.
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);

		const vale = await Vale.fromConfig({ ignoreGlobal: true });
		expect(
			vale
				.lintString("We utilize it.", { path: "buffer.md" })
				.flatMap((f) => f.sortedAlerts()),
		).toHaveLength(1);
		// The same text as a `.txt` file matches no section, so no rule runs.
		expect(
			vale
				.lintString("We utilize it.", { path: "buffer.txt" })
				.flatMap((f) => f.sortedAlerts()),
		).toHaveLength(0);
	});

	test("a directory is walked", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("docs/a.md", "We utilize it.\n");
		write("docs/b.md", "We utilize it too.\n");
		write("docs/c.txt", "We utilize it as well.\n");

		const vale = await Vale.fromConfig({ ignoreGlobal: true });
		const files = vale.lintFile("docs");
		// With nothing turned on globally, a file no section matches has no
		// rules at all, so the walk does not read it: `c.txt` never appears.
		expect(files.map((f) => path.basename(f.path)).sort()).toEqual([
			"a.md",
			"b.md",
		]);
		expect(files.flatMap((f) => f.sortedAlerts())).toHaveLength(2);
	});

	test("a glob narrows the walk", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("docs/a.md", "We utilize it.\n");
		write("docs/b.md", "We utilize it too.\n");

		const vale = await Vale.fromConfig({ ignoreGlobal: true });
		const files = vale.lintFile("docs", "*a.md");
		expect(files.map((f) => path.basename(f.path))).toEqual(["a.md"]);
	});
});

describe("one case per rule type", () => {
	test("existence", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: warning\ntokens:\n  - utilize\n",
		);
		write("doc.md", "We utilize it.\n");
		expect(await lint("doc.md")).toEqual(["1:4:T.Rule:found 'utilize'"]);
	});

	test("substitution", async () => {
		project(
			"extends: substitution\nmessage: \"Use '%s' instead of '%s'.\"\nlevel: warning\nswap:\n  utilize: use\n",
		);
		write("doc.md", "We utilize it.\n");
		expect(await lint("doc.md")).toEqual([
			"1:4:T.Rule:Use 'use' instead of 'utilize'.",
		]);
	});

	test("occurrence", async () => {
		project(
			"extends: occurrence\nmessage: \"Too many words.\"\nlevel: warning\nscope: sentence\nmax: 3\ntoken: '\\b(\\w+)\\b'\n",
		);
		write("doc.md", "One two three four five.\n");
		expect(await lint("doc.md")).toHaveLength(1);
	});

	test("repetition", async () => {
		// `ignorecase` matters: without it the comparison is case-sensitive, so
		// "This this" is two different words. Vale's own Repetition rule sets it.
		project(
			"extends: repetition\nmessage: \"'%s' is repeated.\"\nlevel: warning\nalpha: true\nignorecase: true\ntokens:\n  - '[^\\s]+'\n",
		);
		write("doc.md", "This this is repeated.\n");
		// The alert is placed at the first of the two, which is where the
		// repetition starts.
		expect(await lint("doc.md")).toEqual(["1:1:T.Rule:'this' is repeated."]);
	});

	test("consistency", async () => {
		project(
			"extends: consistency\nmessage: \"Inconsistent spelling of '%s'.\"\nlevel: warning\nnonword: false\nignorecase: true\neither:\n  advisor: adviser\n",
		);
		write("doc.md", "An advisor and an adviser.\n");
		expect((await lint("doc.md")).length).toBeGreaterThan(0);
	});

	test("capitalization", async () => {
		project(
			"extends: capitalization\nmessage: \"'%s' should be sentence-cased.\"\nlevel: warning\nscope: heading\nmatch: $sentence\n",
		);
		write("doc.md", "# A Heading That Is Title Cased\n");
		expect((await lint("doc.md")).length).toBeGreaterThan(0);
	});

	test("conditional", async () => {
		project(
			"extends: conditional\nmessage: \"'%s' has no definition.\"\nlevel: warning\nscope: text\nignorecase: false\nfirst: '\\b([A-Z]{3,5})\\b'\nsecond: '(?:\\b[A-Z][a-z]+ )+\\(([A-Z]{3,5})\\)'\n",
		);
		write("doc.md", "The NFL is a league.\n");
		expect((await lint("doc.md")).length).toBeGreaterThan(0);
	});

	test("readability", async () => {
		project(
			// The metric name is matched exactly, and the canonical spelling is
			// capitalized; a misspelled one scores zero and reports nothing.
			'extends: readability\nmessage: "Grade level is %s."\nlevel: warning\nmetrics:\n  - Flesch-Kincaid\ngrade: 1\n',
		);
		write(
			"doc.md",
			"Notwithstanding the aforementioned considerations, the implementation " +
				"of comprehensive organizational restructuring necessitates " +
				"extraordinary deliberation.\n",
		);
		expect((await lint("doc.md")).length).toBeGreaterThan(0);
	});

	test("metric", async () => {
		project(
			'extends: metric\nmessage: "There are %s words."\nlevel: warning\nformula: |\n  words\ncondition: "> 2"\n',
		);
		write("doc.md", "One two three four.\n");
		expect((await lint("doc.md")).length).toBeGreaterThan(0);
	});

	test("script", async () => {
		project(
			[
				"extends: script",
				"message: \"'%s' is a long word.\"",
				"level: warning",
				"scope: paragraph",
				"script: |",
				'  text := import("text")',
				"  matches := []",
				"  for m in text.re_find(`[A-Za-z]{12,}`, scope, -1) {",
				"    matches = append(matches, {begin: m[0].begin, end: m[0].end})",
				"  }",
				"",
			].join("\n"),
		);
		write("doc.md", "An interdepartmental reorganization.\n");
		// Both words are twelve characters or more, so both are reported.
		expect(await lint("doc.md")).toEqual([
			"1:4:T.Rule:'interdepartmental' is a long word.",
			"1:22:T.Rule:'reorganization' is a long word.",
		]);
	});

	test("spelling", async () => {
		project(
			"extends: spelling\nmessage: \"Did you really mean '%s'?\"\nlevel: error\n",
		);
		write("doc.md", "A speling mistake.\n");
		expect((await lint("doc.md")).length).toBeGreaterThan(0);
	});

	test("sequence", async () => {
		project(
			[
				"extends: sequence",
				'message: "Avoid ambiguous pronouns."',
				"level: warning",
				"ignorecase: true",
				"tokens:",
				"  - tag: NN|NNP|NNPS|NNS",
				"    skip: 4",
				"  - pattern: \\w+",
				"    tag: PRP",
				"    target: true",
				"",
			].join("\n"),
		);
		write("doc.md", "The dog chased the cat until it tired.\n");
		expect((await lint("doc.md")).length).toBeGreaterThan(0);
	});
});

describe("what the configuration decides", () => {
	test("MinAlertLevel hides what is below it", async () => {
		write(
			".vale.ini",
			"StylesPath = styles\nMinAlertLevel = error\n\n[*.md]\nBasedOnStyles = T\n",
		);
		write(
			"styles/T/Rule.yml",
			"extends: existence\nmessage: \"found '%s'\"\nlevel: warning\ntokens:\n  - utilize\n",
		);
		write("doc.md", "We utilize it.\n");
		expect(await lint("doc.md")).toEqual([]);
	});

	test("a section's level overrides the rule's, for that format alone", async () => {
		write(
			".vale.ini",
			[
				"StylesPath = styles",
				"MinAlertLevel = suggestion",
				"",
				"[*.md]",
				"BasedOnStyles = T",
				"T.Rule = error",
				"",
				"[*.txt]",
				"BasedOnStyles = T",
				"",
			].join("\n"),
		);
		write(
			"styles/T/Rule.yml",
			"extends: existence\nmessage: \"found '%s'\"\nlevel: warning\ntokens:\n  - utilize\n",
		);
		write("a.md", "We utilize it.\n");
		write("a.txt", "We utilize it.\n");

		const vale = await Vale.fromConfig({ ignoreGlobal: true });
		const md = vale.lintFile("a.md").flatMap((f) => f.sortedAlerts());
		const txt = vale.lintFile("a.txt").flatMap((f) => f.sortedAlerts());
		expect(md[0]?.severity).toBe("error");
		expect(txt[0]?.severity).toBe("warning");
	});

	test("a rule can be switched off by name", async () => {
		write(
			".vale.ini",
			"StylesPath = styles\nMinAlertLevel = suggestion\n\n[*.md]\nBasedOnStyles = T\nT.Rule = NO\n",
		);
		write(
			"styles/T/Rule.yml",
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("doc.md", "We utilize it.\n");
		expect(await lint("doc.md")).toEqual([]);
	});

	test("an in-text comment switches a rule off and on again", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write(
			"doc.md",
			[
				"We utilize it.",
				"",
				"<!-- vale off -->",
				"",
				"We utilize it here too.",
				"",
				"<!-- vale on -->",
				"",
				"And we utilize it again.",
				"",
			].join("\n"),
		);
		const alerts = await lint("doc.md");
		expect(alerts).toHaveLength(2);
		expect(alerts[0]).toContain("1:");
		expect(alerts[1]).toContain("9:");
	});

	test("a section applies only where its glob matches", async () => {
		write(
			".vale.ini",
			"StylesPath = styles\nMinAlertLevel = suggestion\n\n[docs/*.md]\nBasedOnStyles = T\n",
		);
		write(
			"styles/T/Rule.yml",
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("docs/in.md", "We utilize it.\n");
		write("out.md", "We utilize it.\n");

		const vale = await Vale.fromConfig({ ignoreGlobal: true });
		expect(
			vale.lintFile("docs/in.md").flatMap((f) => f.sortedAlerts()),
		).toHaveLength(1);
		expect(vale.lintFile("out.md").flatMap((f) => f.sortedAlerts())).toHaveLength(
			0,
		);
	});

	test("a conditional section applies only where its `if` holds", async () => {
		write(
			".vale.ini",
			[
				"StylesPath = styles",
				"MinAlertLevel = suggestion",
				"",
				"[*.md if .Meta.draft]",
				"BasedOnStyles = T",
				"",
			].join("\n"),
		);
		write(
			"styles/T/Rule.yml",
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("draft.md", "---\ndraft: true\n---\n\nWe utilize it.\n");
		write("final.md", "---\ndraft: false\n---\n\nWe utilize it.\n");

		const vale = await Vale.fromConfig({ ignoreGlobal: true });
		expect(vale.lintFile("draft.md").flatMap((f) => f.sortedAlerts())).toHaveLength(
			1,
		);
		expect(vale.lintFile("final.md").flatMap((f) => f.sortedAlerts())).toHaveLength(
			0,
		);
	});

	test("a vocabulary accepts a word the speller would reject", async () => {
		write(
			".vale.ini",
			[
				"StylesPath = styles",
				"MinAlertLevel = suggestion",
				"Vocab = Project",
				"",
				"[*.md]",
				"BasedOnStyles = Vale",
				"",
			].join("\n"),
		);
		write("styles/config/vocabularies/Project/accept.txt", "Flarp\n");
		write("doc.md", "A Flarp and a Blorp.\n");

		const alerts = await lint("doc.md");
		expect(alerts.join("\n")).not.toContain("Flarp");
		expect(alerts.join("\n")).toContain("Blorp");
	});

	test("TokenIgnores keeps a match out of the lint", async () => {
		write(
			".vale.ini",
			[
				"StylesPath = styles",
				"MinAlertLevel = suggestion",
				"",
				"[*.md]",
				"BasedOnStyles = T",
				"TokenIgnores = (\\{\\{[^}]+\\}\\})",
				"",
			].join("\n"),
		);
		write(
			"styles/T/Rule.yml",
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("doc.md", "We {{ utilize }} it.\n");
		expect(await lint("doc.md")).toEqual([]);
	});
});

describe("where an alert lands", () => {
	test("a match in a heading is reported in the heading", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("doc.md", "# We utilize it\n\nAnd again we utilize it.\n");
		expect(await lint("doc.md")).toEqual([
			"1:6:T.Rule:found 'utilize'",
			"3:14:T.Rule:found 'utilize'",
		]);
	});

	test("every occurrence gets its own alert, in order", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("doc.md", "We utilize and utilize and utilize.\n");
		expect(await lint("doc.md")).toEqual([
			"1:4:T.Rule:found 'utilize'",
			"1:16:T.Rule:found 'utilize'",
			"1:28:T.Rule:found 'utilize'",
		]);
	});

	test("a match inside a code span is not reported", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("doc.md", "Call `utilize()` and then utilize it.\n");
		expect(await lint("doc.md")).toEqual(["1:27:T.Rule:found 'utilize'"]);
	});

	test("a match inside a fenced block is not reported", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("doc.md", "```\nutilize\n```\n\nAnd utilize here.\n");
		expect(await lint("doc.md")).toEqual(["5:5:T.Rule:found 'utilize'"]);
	});

	test("a match in front matter is reported at its value", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - utilize\n",
		);
		write("doc.md", "---\ntitle: We utilize it\n---\n\nBody.\n");
		expect(await lint("doc.md")).toEqual(["2:11:T.Rule:found 'utilize'"]);
	});

	test("a match wrapped across a line is still placed", async () => {
		project(
			"extends: existence\nmessage: \"found '%s'\"\nlevel: error\ntokens:\n  - 'the\\s+old\\s+model'\n",
		);
		write("doc.md", "This is the old\nmodel here.\n");
		expect(await lint("doc.md")).toEqual(["1:9:T.Rule:found 'the old model'"]);
	});
});
