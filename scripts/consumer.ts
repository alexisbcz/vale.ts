#!/usr/bin/env bun
/**
 * Installs the packed tarballs into a throwaway project and uses them.
 *
 * Everything else here tests the repository; this tests what leaves it. A
 * tarball can be built, typecheck and bundle correctly and still be unusable
 * -- a file missing from `files`, a `bin` pointing at TypeScript, a dependency
 * still written as `workspace:*` that no registry can resolve. Each of those
 * is invisible until someone installs it, so it is installed here, with `npm`
 * and run under Node: the pairing a consumer is least likely to share with
 * this repository.
 *
 * Run `bun run pack` first.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ROOT } from "./manifest.ts";

const ARTIFACTS = path.join(ROOT, ".artifacts");

const tarballs = readdirSync(ARTIFACTS)
	.filter((n) => n.endsWith(".tgz"))
	.map((n) => path.join(ARTIFACTS, n));

if (tarballs.length === 0) {
	console.error("no tarballs in .artifacts/ -- run `bun run pack` first");
	process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), "vale-ts-consumer-"));

/** Runs a command in the throwaway project, failing the script if it cannot. */
function run(cmd: string, args: string[], expect = 0): string {
	const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	if (r.status !== expect) {
		console.error(`${cmd} ${args.join(" ")} exited ${r.status}, wanted ${expect}`);
		console.error(out);
		process.exit(1);
	}
	return out;
}

writeFileSync(
	path.join(dir, "package.json"),
	`${JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2)}\n`,
);

// Every tarball at once: they depend on each other by version, and npm
// resolves those against the files on the command line rather than the
// registry, which is also what proves the versions line up.
run("npm", ["install", "--no-audit", "--no-fund", ...tarballs]);

// A `StylesPath` that is set has to exist, even when every rule is built in.
mkdirSync(path.join(dir, "styles"));
writeFileSync(
	path.join(dir, ".vale.ini"),
	"StylesPath = styles\nMinAlertLevel = suggestion\n\n[*.md]\nVale.Repetition = YES\n",
);
writeFileSync(path.join(dir, "doc.md"), "This this is a repeated word.\n");
writeFileSync(
	path.join(dir, "use.mjs"),
	[
		'import { lint } from "vale-ts";',
		'for (const a of await lint("doc.md")) {',
		"\tconsole.log(`${a.path}:${a.line}:${a.span[0]}:${a.check}:${a.message}`);",
		"}",
		"",
	].join("\n"),
);

const WANT = "doc.md:1:1:Vale.Repetition:'this' is repeated!";

const library = run("node", ["use.mjs"]).trim();
// The CLI exits 1 when it reports an error-level alert, which this one is.
const cli = run(
	path.join("node_modules", ".bin", "vale-ts"),
	["--output=line", "--no-global", "doc.md"],
	1,
).trim();

let failed = 0;
for (const [what, got] of [
	["the library", library],
	["the command", cli],
] as const) {
	if (got === WANT) {
		console.log(`  ok    ${what}`);
		continue;
	}
	failed++;
	console.log(`  FAIL  ${what}\n        want: ${WANT}\n        got:  ${got}`);
}

if (failed > 0) process.exit(1);
console.log(
	`\nthe published packages work: installed from ${tarballs.length} tarballs`,
);
