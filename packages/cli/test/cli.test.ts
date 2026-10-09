/**
 * `run(argv)`: the exit codes, and the screens that are not a lint run.
 *
 * Everything here goes through `run` rather than a subprocess, which is how the
 * compatibility suite checks a case too.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { run } from "../src/main.ts";
import { capture } from "../src/out.ts";
import { setTerminal } from "../src/tty.ts";
import { setVersion } from "../src/version.ts";
import { inTempDir } from "./helpers.ts";

let cwd = "";

beforeEach(() => {
	cwd = process.cwd();
	setTerminal(false, false);
});

afterEach(() => {
	process.chdir(cwd);
});

/** Runs `argv` and returns the exit code with what it printed. */
async function invoke(
	argv: string[],
): Promise<{ code: number; out: string; err: string; combined: string }> {
	let code = -1;
	const captured = await capture(async () => {
		code = await run(argv);
	});
	return { code, ...captured };
}

/** A project with one rule and one document, in a scratch directory. */
function project(dir: string): void {
	mkdirSync(path.join(dir, "styles", "T"), { recursive: true });
	writeFileSync(
		path.join(dir, ".vale.ini"),
		"StylesPath = styles\nMinAlertLevel = suggestion\n\n[*.md]\nBasedOnStyles = T\n",
	);
	writeFileSync(
		path.join(dir, "styles", "T", "Live.yml"),
		"extends: existence\nmessage: \"'%s' left in text\"\nlevel: error\ntokens:\n  - TODO\n",
	);
	writeFileSync(
		path.join(dir, "styles", "T", "Dead.yml"),
		'extends: existence\nmessage: "never"\nlevel: error\ntokens:\n  - zzzz-nothing\n',
	);
	writeFileSync(path.join(dir, "doc.md"), "A TODO left here.\n");
	writeFileSync(path.join(dir, "clean.md"), "Nothing here.\n");
}

describe("the screens", () => {
	test("--version", async () => {
		const was = setVersion("9.9.9");
		try {
			const r = await invoke(["--version"]);
			expect(r.code).toBe(0);
			expect(r.out).toBe("vale version 9.9.9\n");
		} finally {
			setVersion(was);
		}
	});

	test("--help lists the flags and the commands", async () => {
		const r = await invoke(["--help"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("vale - A command-line linter for prose.");
		expect(r.out).toContain("\nFlags:\n");
		expect(r.out).toContain("\nMore flags:\n");
		expect(r.out).toContain("\nCommands:\n");
		expect(r.out).toContain("Run vale <command> --help for a command's own help.");

		// The hidden flags stay hidden.
		for (const hidden of ["--apply", "--counts", "--sort", "--normalize"]) {
			expect(r.out).not.toContain(`${hidden} `);
		}
	});

	test("help <command> is that command's help", async () => {
		const r = await invoke(["help", "sync"]);
		expect(r.code).toBe(0);
		expect(
			r.out.startsWith(
				"vale sync - Download and install external configuration sources.\n",
			),
		).toBe(true);
		expect(r.out).toContain("Usage:\tvale sync\n");
		expect(r.out).toContain("See https://vale.sh for more.\n");
	});

	test("help with an unknown or hidden name falls back to the listing", async () => {
		expect((await invoke(["help", "nope"])).out).toContain("\nCommands:\n");
		// `dc` is reachable but unlisted, so its own help is not offered.
		expect((await invoke(["help", "dc"])).out).toContain("\nCommands:\n");
	});

	test("<command> --help is a question about the command", async () => {
		const r = await invoke(["sync", "--help"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("vale sync - ");
	});
});

describe("exit codes", () => {
	test("a bogus flag reports itself, prints the usage, and exits 2", async () => {
		const r = await invoke(["--bogus"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("unknown flag: --bogus");
		expect(r.err).toContain("vale - A command-line linter for prose.");
		expect(r.out).toBe("");
	});

	test("a mistyped command exits 2 rather than linting the word", async () => {
		await inTempDir(async (_dir) => {
			const r = await invoke(["snyc"]);
			expect(r.code).toBe(2);
			expect(r.err).toContain("unknown command snyc");
			expect(r.err).toContain("Did you mean sync?");
		});
	});

	test("a command's own failure exits 2", async () => {
		const r = await invoke(["ls-metrics"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("[ls-metrics] Runtime error");
		expect(r.err).toContain("one argument expected");
	});

	test("the error format follows --output", async () => {
		const line = await invoke(["--output=line", "ls-metrics"]);
		expect(line.err.trim()).toBe("[ls-metrics]:E100:one argument expected");

		const json = await invoke(["--output=JSON", "ls-metrics"]);
		expect(json.err).toContain('"Code": "E100"');
		expect(json.err).toContain('"Text": "one argument expected"');
	});

	test("alerts found exits 1, a clean document exits 0", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			const found = await invoke(["--no-global", "--output=line", "doc.md"]);
			expect(found.code).toBe(1);
			expect(found.out).toBe("doc.md:1:3:T.Live:'TODO' left in text\n");

			const clean = await invoke(["--no-global", "--output=line", "clean.md"]);
			expect(clean.code).toBe(0);
			expect(clean.out).toBe("");
		});
	});

	test("--no-exit keeps a run with alerts at 0", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			const r = await invoke([
				"--no-global",
				"--no-exit",
				"--output=line",
				"doc.md",
			]);
			expect(r.code).toBe(0);
			expect(r.out).not.toBe("");
		});
	});

	test("an argument that is not a path and not a string exits 2", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			const r = await invoke([
				"--no-global",
				"--output=line",
				"doc.md",
				"missing.md",
			]);
			expect(r.code).toBe(2);
			expect(r.err).toContain("argument 'missing.md' does not exist");
		});
	});

	test("one argument that is not a path is the document itself", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			const r = await invoke([
				"--no-global",
				"--output=line",
				"--ext=.md",
				"A TODO here.",
			]);
			expect(r.code).toBe(1);
			expect(r.out).toContain("T.Live:'TODO' left in text");
		});
	});
});

describe("the commands", () => {
	test("--counts adds the per-check tally, zeros included", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			const r = await invoke([
				"--no-global",
				"--output=JSON",
				"--counts",
				"doc.md",
			]);
			expect(r.code).toBe(1);
			expect(r.out).toContain(`  "counts": {
    "T.Dead": 0,
    "T.Live": 1
  }`);
		});
	});

	test("ls-config prints the configuration with Go's field names", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			const r = await invoke(["--no-global", "ls-config"]);
			expect(r.code).toBe(0);

			const parsed = JSON.parse(r.out) as Record<string, unknown>;
			expect(Object.keys(parsed)[0]).toBe("BlockIgnores");
			expect(parsed.SBaseStyles).toEqual({ "*.md": ["T"] });
			expect(parsed.Checks).toBeNull();
			expect(parsed.MinAlertLevel).toBe(0);
			expect(parsed.ConfigFiles).toEqual([path.join(dir, ".vale.ini")]);
		});
	});

	test("ls-dirs and ls-vars have a JSON form another tool parses", async () => {
		const dirs = await invoke(["--output=JSON", "ls-dirs"]);
		expect(dirs.code).toBe(0);
		expect(Object.keys(JSON.parse(dirs.out))).toEqual([
			".vale.ini",
			"StylesPath",
			"vale-native",
		]);

		const vars = await invoke(["--output=JSON", "ls-vars"]);
		expect(vars.code).toBe(0);
		expect(Object.keys(JSON.parse(vars.out))).toEqual([
			"VALE_CONFIG_PATH",
			"VALE_STYLES_PATH",
		]);
	});

	test("ls-dirs and ls-vars draw a table for a person", async () => {
		const dirs = await invoke(["ls-dirs"]);
		expect(dirs.out.split("\n")[0]).toContain("Asset       | Default Location");
		const vars = await invoke(["ls-vars"]);
		expect(vars.out).toContain("Variable         | Description");
	});

	test("ls-path names the configuration files in scope", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			const r = await invoke(["--no-global", "ls-path"]);
			expect(r.code).toBe(0);
			expect(JSON.parse(r.out)).toEqual({
				configs: [path.join(dir, ".vale.ini")],
			});
		});
	});

	test("ls-metrics counts a document", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			const r = await invoke(["--no-global", "ls-metrics", "doc.md"]);
			expect(r.code).toBe(0);

			const metrics = JSON.parse(r.out) as Record<string, number>;
			expect(metrics.words).toBe(4);
			expect(metrics.sentences).toBe(1);
			// A Go map is marshalled in sorted key order.
			const keys = Object.keys(metrics);
			expect([...keys].sort()).toEqual(keys);
		});
	});

	test("ls-metrics on a directory with nothing to lint says so", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			mkdirSync(path.join(dir, "empty", "node_modules"), { recursive: true });
			writeFileSync(path.join(dir, "empty/node_modules/test.md"), "# Title\n");

			const r = await invoke([
				"--no-global",
				"--output=line",
				"ls-metrics",
				"empty",
			]);
			expect(r.code).toBe(2);
			expect(r.err.trim()).toBe(
				"[ls-metrics]:E100:'empty' contains no lintable files",
			);
		});
	});
});

describe("--output=<template>", () => {
	test("a template file renders the run", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			writeFileSync(
				path.join(dir, "out.tmpl"),
				"{{range .Files}}{{$p := .Path}}{{range .Alerts}}" +
					"{{$p}}|{{.Line}}|{{.Check}}\n{{end}}{{end}}",
			);

			const r = await invoke(["--no-global", "--output=out.tmpl", "doc.md"]);
			expect(r.code).toBe(1);
			expect(r.out).toBe("doc.md|1|T.Live\n");
		});
	});

	test("a template that is not there is a template error", async () => {
		await inTempDir(async (dir) => {
			project(dir);

			const r = await invoke([
				"--no-global",
				"--output=nope.tmpl",
				"--output=nope.tmpl",
				"doc.md",
			]);
			expect(r.code).toBe(2);
			expect(r.err).toContain("[template] Runtime error");
		});
	});
});
