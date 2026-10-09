/**
 * `fix --apply`: the span arithmetic, the conflict policy, and one run
 * end-to-end.
 *
 * A port of `cmd/vale/apply_test.go`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { newAlert } from "@vale-ts/core";
import {
	type FixedFile,
	lineOffsets,
	resolveEdits,
	spanOf,
	widenRemoval,
} from "../src/apply.ts";
import { run } from "../src/main.ts";
import { capture } from "../src/out.ts";
import { setTerminal } from "../src/tty.ts";
import { inTempDir } from "./helpers.ts";

let cwd = "";

beforeEach(() => {
	cwd = process.cwd();
	setTerminal(false, false);
});

afterEach(() => {
	process.chdir(cwd);
});

/** The configuration and rules the end-to-end cases rewrite against. */
function fixture(dir: string): void {
	const files: Record<string, string> = {
		".vale.ini":
			"StylesPath = styles\nMinAlertLevel = suggestion\n\n[*]\nBasedOnStyles = T\n",
		"styles/T/Swap.yml":
			"extends: substitution\nmessage: \"Use '%s'.\"\nlevel: warning\n" +
			"action:\n  name: replace\nswap:\n  utilize: use\n  leverage: exploit\n",
		"styles/T/Multi.yml":
			"extends: existence\nmessage: \"Vague: '%s'.\"\nlevel: warning\n" +
			"action:\n  name: replace\n  params:\n    - alpha\n    - beta\ntokens:\n  - vagueterm\n",
		"styles/T/OverA.yml":
			"extends: substitution\nmessage: \"Use '%s'.\"\nlevel: warning\n" +
			"action:\n  name: replace\nswap:\n  quite bad: poor\n",
		"styles/T/OverB.yml":
			"extends: substitution\nmessage: \"Use '%s'.\"\nlevel: warning\n" +
			"action:\n  name: replace\nswap:\n  bad outcome: failure\n",
	};

	for (const [name, body] of Object.entries(files)) {
		const p = path.join(dir, name);
		mkdirSync(path.dirname(p), { recursive: true });
		writeFileSync(p, body);
	}
}

describe("resolveEdits", () => {
	test("duplicates collapse and an overlapping cluster is skipped", () => {
		const report: FixedFile = { Path: "", Applied: 0, Skipped: [] };
		const kept = resolveEdits(
			[
				{ begin: 40, end: 50, text: "x", check: "T.C", line: 2, col: 1 },
				{ begin: 0, end: 5, text: "a", check: "T.A", line: 1, col: 1 },
				{ begin: 0, end: 5, text: "a", check: "T.B", line: 1, col: 1 },
				{ begin: 44, end: 60, text: "y", check: "T.D", line: 2, col: 5 },
			],
			report,
		);

		expect(kept.length).toBe(1);
		expect(kept[0]?.check).toBe("T.A");
		expect(report.Skipped.map((s) => s.Reason)).toEqual([
			"overlaps T.D",
			"overlaps T.C",
		]);
	});

	test("adjacent but not overlapping edits are both kept", () => {
		const report: FixedFile = { Path: "", Applied: 0, Skipped: [] };
		const kept = resolveEdits(
			[
				{ begin: 0, end: 5, text: "a", check: "T.A", line: 1, col: 1 },
				{ begin: 5, end: 9, text: "b", check: "T.B", line: 1, col: 6 },
			],
			report,
		);
		expect(kept.length).toBe(2);
		expect(report.Skipped).toEqual([]);
	});
});

describe("spanOf", () => {
	const raw = "naïve café here\nsecond line\n";
	const starts = lineOffsets(raw);

	test("maps character columns, multi-byte characters included", () => {
		// "café" is characters 7 to 10 of line one.
		const at = spanOf(
			raw,
			starts,
			newAlert({ line: 1, span: [7, 10], match: "café" }),
		);
		expect(at).not.toBeNull();
		expect(raw.slice(at![0], at![1])).toBe("café");
	});

	test("refuses a span whose text is not the match", () => {
		expect(
			spanOf(raw, starts, newAlert({ line: 1, span: [7, 10], match: "cafe" })),
		).toBeNull();
	});

	test("refuses a span past the end of its line", () => {
		expect(
			spanOf(raw, starts, newAlert({ line: 2, span: [1, 99], match: "second" })),
		).toBeNull();
	});

	test("refuses a line that is not there", () => {
		expect(
			spanOf(raw, starts, newAlert({ line: 9, span: [1, 2], match: "x" })),
		).toBeNull();
	});
});

describe("widenRemoval", () => {
	test("a removal takes one adjacent space", () => {
		const raw = "a very good one";
		expect(widenRemoval(raw, 2, 6)).toEqual([2, 7]); // "very " -- after
		expect(widenRemoval(raw, 12, 15)).toEqual([11, 15]); // " one" -- before
		expect(widenRemoval(raw, 0, 1)).toEqual([0, 2]); // "a " -- at the start
	});

	test("with no space either side, nothing widens", () => {
		expect(widenRemoval("x-y", 0, 1)).toEqual([0, 1]);
	});
});

describe("lineOffsets", () => {
	test("one entry per line, starting at zero", () => {
		expect(lineOffsets("a\nbb\n\nc")).toEqual([0, 2, 5, 6]);
		expect(lineOffsets("")).toEqual([0]);
	});
});

describe("fix --apply", () => {
	test("writes the unambiguous fixes and reports the rest", async () => {
		await inTempDir(async (dir) => {
			fixture(dir);

			const doc = path.join(dir, "doc.md");
			writeFileSync(
				doc,
				"We should utilize the API and leverage the cache.\n\n" +
					"This vagueterm stays, and this was a quite bad outcome.\n",
			);

			const clean = path.join(dir, "clean.md");
			writeFileSync(clean, "Nothing actionable here at all.\n");
			const before = statSync(clean).mtimeMs;

			let code = -1;
			const out = await capture(async () => {
				code = await run(["--no-global", "fix", "--apply", doc, clean]);
			});
			expect(code).toBe(0);

			expect(readFileSync(doc, "utf8")).toBe(
				"We should use the API and exploit the cache.\n\n" +
					"This vagueterm stays, and this was a quite bad outcome.\n",
			);

			// A file with nothing to apply is neither rewritten nor touched.
			expect(readFileSync(clean, "utf8")).toBe("Nothing actionable here at all.\n");
			expect(statSync(clean).mtimeMs).toBe(before);

			expect(out.out).toContain("applied 2, skipped 3");
			expect(out.out).toContain("T.Multi\t2 suggestions");
			expect(out.out).toContain("T.OverA\toverlaps T.OverB");
			expect(out.out).toContain("T.OverB\toverlaps T.OverA");
		});
	});

	test("a removal does not leave two spaces behind", async () => {
		await inTempDir(async (dir) => {
			fixture(dir);
			writeFileSync(
				path.join(dir, "styles", "T", "Drop.yml"),
				"extends: existence\nmessage: \"Drop '%s'.\"\nlevel: warning\n" +
					"action:\n  name: remove\ntokens:\n  - very\n",
			);

			const doc = path.join(dir, "doc.md");
			writeFileSync(doc, "This is very good.\n\nIt is fine, very\n");

			let code = -1;
			await capture(async () => {
				code = await run(["--no-global", "fix", "--apply", doc]);
			});
			expect(code).toBe(0);
			expect(readFileSync(doc, "utf8")).toBe("This is good.\n\nIt is fine,\n");
		});
	});

	test("the JSON report carries the same answer", async () => {
		await inTempDir(async (dir) => {
			fixture(dir);
			const doc = path.join(dir, "doc.md");
			writeFileSync(doc, "We should utilize the API.\n");

			let code = -1;
			const out = await capture(async () => {
				code = await run(["--no-global", "--output=JSON", "fix", "--apply", doc]);
			});
			expect(code).toBe(0);

			const parsed = JSON.parse(out.out) as FixedFile[];
			expect(parsed[0]?.Applied).toBe(1);
			expect(parsed[0]?.Skipped).toEqual([]);
		});
	});

	test("a path that is not there is reported, not guessed at", async () => {
		await inTempDir(async (dir) => {
			fixture(dir);

			let code = -1;
			const out = await capture(async () => {
				code = await run([
					"--no-global",
					"--output=line",
					"fix",
					"--apply",
					"nope.md",
				]);
			});
			expect(code).toBe(2);
			expect(out.err.trim()).toBe("[fix]:E100:path 'nope.md' does not exist");
		});
	});

	test("--apply with no path at all is an error", async () => {
		await inTempDir(async () => {
			let code = -1;
			const out = await capture(async () => {
				code = await run(["--no-global", "--output=line", "fix", "--apply"]);
			});
			expect(code).toBe(2);
			expect(out.err.trim()).toBe("[fix]:E100:at least one path expected");
		});
	});
});
