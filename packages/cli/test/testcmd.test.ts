/**
 * `vale test`: the report, the exit codes, and the parts of a case file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { run } from "../src/main.ts";
import { capture } from "../src/out.ts";
import { uncovered } from "../src/testsuite/coverage.ts";
import { Add, Del, diff, Same } from "../src/testsuite/diff.ts";
import { compare } from "../src/testsuite/run.ts";
import { loadCases } from "../src/testsuite/suite.ts";
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

/** Writes `files` under `dir`, creating the directories they need. */
function write(dir: string, files: Record<string, string>): void {
	for (const [name, body] of Object.entries(files)) {
		const p = path.join(dir, name);
		mkdirSync(path.dirname(p), { recursive: true });
		writeFileSync(p, body);
	}
}

const PROJECT: Record<string, string> = {
	".vale.ini":
		"StylesPath = styles\nMinAlertLevel = suggestion\n\n[*.md]\nBasedOnStyles = T\n",
	"styles/T/Weasel.yml":
		"extends: existence\nmessage: \"'%s' is a weasel word!\"\nlevel: warning\n" +
		"tokens:\n  - really\n\ntests:\n" +
		"  - name: flags a weasel word\n    input: We really need this.\n" +
		"    want: |\n      1:4:T.Weasel:'really' is a weasel word!\n" +
		'  - name: never fires\n    input: Plain prose.\n    want: ""\n',
};

/** Runs `argv` and returns the code with what it printed. */
async function invoke(argv: string[]) {
	let code = -1;
	const captured = await capture(async () => {
		code = await run(argv);
	});
	return { code, ...captured };
}

describe("diff", () => {
	test("a reworded line is one deletion and one addition", () => {
		expect(diff("a\nb\n", "a\nc\n")).toEqual([
			{ op: Same, text: "a" },
			{ op: Del, text: "b" },
			{ op: Add, text: "c" },
		]);
	});

	test("no trailing empty line on either side", () => {
		expect(diff("", "")).toEqual([]);
		expect(diff("a\n", "a\n")).toEqual([{ op: Same, text: "a" }]);
	});

	test("one side empty is all additions or all deletions", () => {
		expect(diff("", "x\ny")).toEqual([
			{ op: Add, text: "x" },
			{ op: Add, text: "y" },
		]);
		expect(diff("x", "")).toEqual([{ op: Del, text: "x" }]);
	});
});

describe("compare", () => {
	const base = {
		name: "c",
		about: "",
		input: "",
		format: "",
		view: "",
		rule: "",
		want: null as string | null,
		contains: [] as string[],
		absent: [] as string[],
		path: "f.yml",
	};

	test("want is compared with the surrounding whitespace ignored", () => {
		expect(compare({ ...base, want: "a\n" }, "a\n")).toBe("");
		expect(compare({ ...base, want: " a " }, "a")).toBe("");
		expect(compare({ ...base, want: "a" }, "b")).toBe("output does not match");
	});

	test("contains and absent name what they were looking for", () => {
		expect(compare({ ...base, contains: ["x"] }, "axb")).toBe("");
		expect(compare({ ...base, contains: ["x"] }, "ab")).toBe(
			'output does not contain "x"',
		);
		expect(compare({ ...base, absent: ["x"] }, "ab")).toBe("");
		expect(compare({ ...base, absent: ["x"] }, "axb")).toBe('output contains "x"');
	});
});

describe("uncovered", () => {
	test("a rule no case made fire is named", () => {
		const results = [
			{
				case: { name: "", path: "" } as never,
				got: "1:4:T.Live:x\n",
				reason: "",
				err: null,
			},
		];
		expect(uncovered(["T.Live", "T.Dead"], results)).toEqual(["T.Dead"]);
	});
});

describe("loadCases", () => {
	test("a rule's in-source cases default to the rule itself", async () => {
		await inTempDir((dir) => {
			write(dir, PROJECT);
			const cases = loadCases(path.join(dir, "styles/T/Weasel.yml"));
			expect(cases.length).toBe(2);
			expect(cases[0]?.rule).toBe("Weasel.yml");
			expect(cases[1]?.want).toBe("");
		});
	});

	test("a .test.yml holds a sequence and takes no default rule", async () => {
		await inTempDir((dir) => {
			write(dir, {
				"T.test.yml": "- name: a\n  input: x\n  contains: T.R\n",
			});
			const cases = loadCases(path.join(dir, "T.test.yml"));
			expect(cases[0]?.rule).toBe("");
			expect(cases[0]?.contains).toEqual(["T.R"]);
		});
	});

	test("YAML that is not a rule with cases is not ours", async () => {
		await inTempDir((dir) => {
			write(dir, {
				".eslintrc.yml": "extends: recommended\nrules:\n  bad: [\n",
				"data.yml": "a: 1\n",
			});
			expect(loadCases(path.join(dir, ".eslintrc.yml"))).toEqual([]);
			expect(loadCases(path.join(dir, "data.yml"))).toEqual([]);
		});
	});

	test("a rule whose cases do not parse is reported at its line", async () => {
		await inTempDir((dir) => {
			write(dir, {
				"styles/T/Colon.yml":
					"extends: existence\nmessage: \"'%s'\"\ntokens:\n  - really\n" +
					"tests:\n  - name: never parses\n    input: Note: really\n" +
					"    contains: T.Colon\n",
			});
			expect(() => loadCases(path.join(dir, "styles/T/Colon.yml"))).toThrow(
				"mapping values are not allowed in this context",
			);
		});
	});

	test("a case that asserts nothing is refused", async () => {
		await inTempDir((dir) => {
			write(dir, { "T.test.yml": "- name: asserts nothing\n  input: x\n" });
			expect(() => loadCases(path.join(dir, "T.test.yml"))).toThrow("needs one of");
		});
	});

	test("two cases cannot share a name", async () => {
		await inTempDir((dir) => {
			write(dir, {
				"T.test.yml": "- name: a\n  contains: x\n- name: a\n  contains: y\n",
			});
			expect(() => loadCases(path.join(dir, "T.test.yml"))).toThrow(
				"duplicate name",
			);
		});
	});
});

describe("the command", () => {
	test("a passing run exits 0 and says how many", async () => {
		await inTempDir(async (dir) => {
			write(dir, PROJECT);
			const r = await invoke(["--no-global", "test", "styles"]);
			expect(r.code).toBe(0);
			expect(r.out).toBe(" SUCCESS  1 file — 2 passed, 0 failed\n");
		});
	});

	test("a failing case exits 1 and shows a diff", async () => {
		await inTempDir(async (dir) => {
			write(dir, PROJECT);
			write(dir, {
				"styles/T/Weasel.yml": PROJECT["styles/T/Weasel.yml"]!.replace(
					"'really' is a weasel word!\n  - name: never fires",
					"nope\n  - name: never fires",
				),
			});

			const r = await invoke(["--no-global", "test", "styles"]);
			expect(r.code).toBe(1);
			expect(r.out).toContain("✗ flags a weasel word — output does not match");
			expect(r.out).toContain("- 1:4:T.Weasel:nope");
			expect(r.out).toContain("+ 1:4:T.Weasel:'really' is a weasel word!");
			expect(r.out).toContain("- expected   + actual");
			expect(r.out).toContain("  ERROR   1 file — 1 passed, 1 failed");
		});
	});

	test("a case that cannot run exits 2, after the rest report", async () => {
		await inTempDir(async (dir) => {
			write(dir, PROJECT);
			write(dir, {
				"styles/T/Broken.yml":
					'extends: Missing.Parent\nmessage: "x"\ntests:\n' +
					"  - name: never loads\n    input: Text.\n    contains: T.Broken\n",
			});

			const r = await invoke(["--no-global", "test", "styles"]);
			expect(r.code).toBe(2);
			expect(r.out).toContain("✗ never loads — could not run");
			// The error is shown as its banner, which carries the excerpt.
			expect(r.out).toContain("E201 Invalid value");
			expect(r.out).toContain("1* extends: Missing.Parent");
			expect(r.err).toContain("1 case could not run");
		});
	});

	test("--coverage names a rule no case made fire", async () => {
		await inTempDir(async (dir) => {
			write(dir, PROJECT);
			write(dir, {
				"styles/T/Silent.yml":
					"extends: existence\nmessage: \"'%s' is banned.\"\nlevel: warning\n" +
					"tokens:\n  - nowhere\n\ntests:\n" +
					'  - name: never fires\n    input: Plain prose.\n    want: ""\n',
			});

			const r = await invoke(["--no-global", "test", "--coverage", "styles"]);
			expect(r.code).toBe(1);
			expect(r.out).toContain("✗ 1 rule produced no alert in any case");
			expect(r.out).toContain("    T.Silent");
			expect(r.out).toContain("3 passed, 0 failed, 1 uncovered");
		});
	});

	test("the JSON report carries every case and the uncovered list", async () => {
		await inTempDir(async (dir) => {
			write(dir, PROJECT);
			const r = await invoke(["--no-global", "--output=JSON", "test", "styles"]);
			expect(r.code).toBe(0);

			const parsed = JSON.parse(r.out) as {
				passed: number;
				failed: number;
				results: Array<Record<string, unknown>>;
				uncovered?: string[];
			};
			expect(parsed.passed).toBe(2);
			expect(parsed.failed).toBe(0);
			expect(parsed.uncovered).toBeUndefined();
			// `omitempty`: a case with no alerts carries no `got`.
			expect(parsed.results[1]).toEqual({
				file: path.join("styles", "T", "Weasel.yml"),
				name: "never fires",
				passed: true,
			});
		});
	});

	test("no file to read is a mistake worth reporting", async () => {
		await inTempDir(async (dir) => {
			write(dir, { "README.md": "Nothing to test here.\n" });
			const r = await invoke(["--no-global", "--output=line", "test"]);
			expect(r.code).toBe(2);
			expect(r.err.trim()).toBe("[test]:E100:no test files found");
		});
	});

	test("an empty run is a mistake too, not a pass", async () => {
		await inTempDir(async (dir) => {
			// A rule with no cases is a file `findCases` considers and finds
			// nothing in, which used to report success.
			write(dir, {
				"styles/T/Plain.yml": 'extends: existence\nmessage: "x"\ntokens:\n  - x\n',
			});
			const r = await invoke(["--no-global", "--output=line", "test"]);
			expect(r.code).toBe(2);
			expect(r.err.trim()).toBe("[test]:E100:no test cases found");
		});
	});
});
