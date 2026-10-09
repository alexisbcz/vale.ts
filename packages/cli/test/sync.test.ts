/**
 * `vale sync`, against the package shapes that need no network: a local
 * directory and a local `.zip`.
 *
 * The remote paths are covered by `pkgver.test.ts` for the version logic and by
 * the compatibility suite for the rest; what is here is the installing itself,
 * which is where a package's layout is decided.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { run } from "../src/main.ts";
import { capture } from "../src/out.ts";
import { pkgRoot } from "../src/sync.ts";
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

function write(dir: string, files: Record<string, string>): void {
	for (const [name, body] of Object.entries(files)) {
		const p = path.join(dir, name);
		mkdirSync(path.dirname(p), { recursive: true });
		writeFileSync(p, body);
	}
}

const RULE =
	'extends: existence\nmessage: "\'%s\' left in text"\nlevel: error\ntokens:\n  - TODO\n';

describe("pkgRoot", () => {
	test("an exact name wins, and a different casing is the fallback", async () => {
		await inTempDir((dir) => {
			mkdirSync(path.join(dir, "MyPkg"));
			expect(pkgRoot(dir, "MyPkg")).toBe("MyPkg");
			// GitHub serves a release asset under any casing of its name.
			expect(pkgRoot(dir, "mypkg")).toBe("MyPkg");
			expect(pkgRoot(dir, "Absent")).toBe("Absent");
		});
	});

	test("a directory it cannot read gives the name back", () => {
		expect(pkgRoot("/nope/nowhere", "Pkg")).toBe("Pkg");
	});
});

describe("a local directory package", () => {
	test("its styles are merged and its config joins the pipeline", async () => {
		await inTempDir(async (dir) => {
			write(dir, {
				".vale.ini":
					"StylesPath = styles\nMinAlertLevel = suggestion\nPackages = Mine\n",
				"Mine/.vale.ini": "[*.md]\nBasedOnStyles = Mine\n",
				"Mine/styles/Mine/Live.yml": RULE,
				"Mine/styles/config/vocabularies/V/accept.txt": "Vale\n",
				"doc.md": "A TODO left here.\n",
			});

			let code = -1;
			const out = await capture(async () => {
				code = await run(["--no-global", "sync", "--plain-progress"]);
			});
			expect(code).toBe(0);
			expect(out.out).toContain("Synced Mine");
			expect(out.out).toContain("Synced 1 package(s) to");

			// The package's `styles` directory lands in the StylesPath.
			expect(readFileSync(path.join(dir, "styles/Mine/Live.yml"), "utf8")).toBe(
				RULE,
			);
			// `config` is merged rather than replaced, so it keeps its name.
			expect(
				existsSync(path.join(dir, "styles/config/vocabularies/V/accept.txt")),
			).toBe(true);
			// The package's own `.vale.ini` is copied under its indexed name,
			// never renamed in place -- that would clobber the user's file.
			expect(existsSync(path.join(dir, "styles/.vale-config/0-Mine.ini"))).toBe(
				true,
			);
			expect(existsSync(path.join(dir, "Mine/.vale.ini"))).toBe(true);

			// The installed section is in scope for the next run.
			const lint = await capture(async () => {
				code = await run(["--no-global", "--output=line", "doc.md"]);
			});
			expect(code).toBe(1);
			expect(lint.out).toBe("doc.md:1:3:Mine.Live:'TODO' left in text\n");
		});
	});
});

describe("a local zip package", () => {
	test("is unpacked and installed like any other", async () => {
		await inTempDir(async (dir) => {
			const archive = zipSync({
				"Zipped/styles/Zipped/Live.yml": new TextEncoder().encode(RULE),
				"Zipped/.vale.ini": new TextEncoder().encode(
					"[*.md]\nBasedOnStyles = Zipped\n",
				),
			});
			writeFileSync(path.join(dir, "Zipped.zip"), archive);

			write(dir, {
				".vale.ini":
					"StylesPath = styles\nMinAlertLevel = suggestion\nPackages = Zipped.zip\n",
				"doc.md": "A TODO left here.\n",
			});

			let code = -1;
			await capture(async () => {
				code = await run(["--no-global", "sync", "--plain-progress"]);
			});
			expect(code).toBe(0);
			expect(
				readFileSync(path.join(dir, "styles/Zipped/Live.yml"), "utf8"),
			).toBe(RULE);

			const lint = await capture(async () => {
				code = await run(["--no-global", "--output=line", "doc.md"]);
			});
			expect(lint.out).toBe("doc.md:1:3:Zipped.Live:'TODO' left in text\n");
		});
	});
});

describe("a style-only package", () => {
	test("a directory with no styles subdirectory is the style itself", async () => {
		await inTempDir(async (dir) => {
			write(dir, {
				".vale.ini":
					"StylesPath = styles\nMinAlertLevel = suggestion\nPackages = Plain\n" +
					"\n[*.md]\nBasedOnStyles = Plain\n",
				"Plain/Live.yml": RULE,
				"doc.md": "A TODO left here.\n",
			});

			let code = -1;
			await capture(async () => {
				code = await run(["--no-global", "sync", "--plain-progress"]);
			});
			expect(code).toBe(0);
			expect(readFileSync(path.join(dir, "styles/Plain/Live.yml"), "utf8")).toBe(
				RULE,
			);
		});
	});
});

describe("sync's own failures", () => {
	test("a package that is neither a path nor a URL is reported", async () => {
		await inTempDir(async () => {
			write(process.cwd(), {
				".vale.ini": "StylesPath = styles\nPackages = ./nowhere\n",
			});

			let code = -1;
			const out = await capture(async () => {
				code = await run([
					"--no-global",
					"--output=line",
					"sync",
					"--plain-progress",
				]);
			});
			expect(code).toBe(2);
			expect(out.err).toContain("[download]:E100:");
		});
	});

	test("the pipeline directory is cleared before a sync", async () => {
		await inTempDir(async (dir) => {
			write(dir, {
				".vale.ini": "StylesPath = styles\nPackages = Mine\n",
				"Mine/.vale.ini": "[*.md]\nBasedOnStyles = Mine\n",
				"Mine/styles/Mine/Live.yml": RULE,
				"styles/.vale-config/9-stale.ini": "[*.md]\nBasedOnStyles = Gone\n",
			});

			let code = -1;
			await capture(async () => {
				code = await run(["--no-global", "sync", "--plain-progress"]);
			});
			expect(code).toBe(0);
			expect(existsSync(path.join(dir, "styles/.vale-config/9-stale.ini"))).toBe(
				false,
			);
		});
	});
});
