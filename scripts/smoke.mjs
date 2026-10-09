/**
 * Lints one document with the built bundle, under whatever runtime started it.
 *
 * The engine is runtime-agnostic TypeScript and the filesystem layer uses
 * `node:` built-ins only, so a consumer on Node should get the same answers as
 * one on Bun. This is what checks that claim: it imports `dist/`, not `src/`,
 * so it also catches a bundling mistake that development never sees.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "vale-ts-smoke-"));

// A `StylesPath` that is set has to exist, even when every rule is built in.
mkdirSync(join(dir, "styles"));

writeFileSync(
	join(dir, ".vale.ini"),
	["StylesPath = styles", "MinAlertLevel = suggestion", "", "[*.md]", "Vale.Repetition = YES", ""].join("\n"),
);
writeFileSync(join(dir, "doc.md"), "This this is a repeated word.\n");

const { Vale } = await import("../packages/vale/dist/index.js");

const cwd = process.cwd();
process.chdir(dir);
try {
	const vale = await Vale.fromConfig();
	const files = vale.lintFile("doc.md");
	const alerts = files.flatMap((f) => f.sortedAlerts());

	if (alerts.length === 0) {
		throw new Error("expected the repetition rule to fire");
	}
	for (const a of alerts) {
		console.log(`doc.md:${a.line}:${a.span[0]}:${a.check}:${a.message}`);
	}
} finally {
	process.chdir(cwd);
}
