/**
 * Tests for the compatibility harness itself.
 *
 * The harness decides what "compatible" means, so a bug in it is worse than a
 * bug in the port: it would either hide a difference or invent one. These check
 * the parts that read Vale's declarations -- the argument splitting, the working
 * directory each case runs in, and the validation that refuses a case asserting
 * nothing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { TESTDATA } from "./fetch.ts";
import { clean, loadSuites, slug, splitArgs } from "./suite.ts";

describe("argument splitting", () => {
	test("splits on spaces", () => {
		expect(splitArgs("--output=line test.md")).toEqual([
			"--output=line",
			"test.md",
		]);
	});

	test("keeps a quoted run together", () => {
		expect(splitArgs(`--filter '.Name == "Vale.Spelling"' .`)).toEqual([
			"--filter",
			'.Name == "Vale.Spelling"',
			".",
		]);
	});

	test("an empty quoted argument survives", () => {
		// `vale --glob '' .` passes an empty glob, which is not the same as
		// passing no glob at all.
		expect(splitArgs("--glob '' .")).toEqual(["--glob", "", "."]);
	});

	test("runs of whitespace collapse", () => {
		expect(splitArgs("  a   b  ")).toEqual(["a", "b"]);
	});
});

describe("output normalization", () => {
	test("trailing whitespace and the final newline go", () => {
		expect(clean("a  \nb\n\n")).toBe("a\nb");
	});

	test("nothing is nothing", () => {
		expect(clean("")).toBe("");
		expect(clean("\n\n")).toBe("");
	});
});

describe("case names as directories", () => {
	test("a slash and a space are replaced", () => {
		expect(slug("sequence/min")).toBe("sequence-min");
		expect(slug("two words")).toBe("two-words");
	});
});

// The corpus is fetched on demand, so these are skipped when it is absent
// rather than failing: `bun test` should work on a fresh checkout.
const corpus = existsSync(path.join(TESTDATA, "e2e"));

describe.skipIf(!corpus)("Vale's own declarations", () => {
	test("every suite loads and validates", () => {
		const suites = loadSuites(path.join(TESTDATA, "e2e"));
		expect(suites.length).toBeGreaterThan(20);

		for (const s of suites) {
			expect(s.name).not.toBe("");
			expect(s.cases.length).toBeGreaterThan(0);
			for (const c of s.cases) {
				expect(c.name).not.toBe("");
				// Validation already refuses a case that asserts nothing; this
				// states the invariant the suite is read under.
				const asserts =
					c.want !== null || c.contains !== "" || c.absent.length > 0;
				expect(asserts).toBe(true);
			}
		}
	});

	test("the corpus is big enough to mean something", () => {
		const suites = loadSuites(path.join(TESTDATA, "e2e"));
		const cases = suites.reduce((n, s) => n + s.cases.length, 0);
		expect(cases).toBeGreaterThan(300);
	});
});
