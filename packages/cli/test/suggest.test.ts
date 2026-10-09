/**
 * Telling a mistyped command from a document.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { capture } from "../src/out.ts";
import { didYouMean, levenshtein, reportUnknownCommand } from "../src/suggest.ts";
import { setTerminal } from "../src/tty.ts";
import { withTempDir } from "./helpers.ts";

beforeEach(() => {
	setTerminal(false, false);
});

describe("levenshtein", () => {
	test("counts edits", () => {
		expect(levenshtein("snyc", "sync")).toBe(2);
		expect(levenshtein("ls-confg", "ls-config")).toBe(1);
		expect(levenshtein("same", "same")).toBe(0);
		expect(levenshtein("", "abc")).toBe(3);
	});
});

describe("didYouMean", () => {
	test("a near miss is the command it is near", () => {
		expect(didYouMean("snyc")).toBe("sync");
		expect(didYouMean("ls-confg")).toBe("ls-config");
		expect(didYouMean("tset")).toBe("test");
		expect(didYouMean("ls-dir")).toBe("ls-dirs");
	});

	test("a hidden command is never suggested", () => {
		// `dc`, `fix` and `run` are reachable but unlisted.
		expect(didYouMean("dd")).toBeNull();
	});

	test("three edits away is a document, not a typo", () => {
		expect(didYouMean("syncopate")).toBeNull();
		expect(didYouMean("README.md")).toBeNull();
	});

	test("anything with whitespace is prose", () => {
		expect(didYouMean("sync now")).toBeNull();
		expect(didYouMean("test\tcase")).toBeNull();
	});

	test("a path that exists is a document", () => {
		withTempDir((dir) => {
			const p = path.join(dir, "tests");
			writeFileSync(p, "x");
			const cwd = process.cwd();
			process.chdir(dir);
			try {
				expect(didYouMean("tests")).toBeNull();
			} finally {
				process.chdir(cwd);
			}
		});
	});
});

describe("reportUnknownCommand", () => {
	test("names the typo, the suggestion and every command", async () => {
		const out = await capture(() => {
			reportUnknownCommand("snyc", "sync");
		});

		expect(out.err).toBe(
			"Error: unknown command snyc\n\n" +
				"Did you mean sync?\n\n" +
				"Commands: ls-config, ls-dirs, ls-metrics, ls-vars, sync, test\n" +
				"Run vale --help for more.\n",
		);
		expect(out.out).toBe("");
	});
});
