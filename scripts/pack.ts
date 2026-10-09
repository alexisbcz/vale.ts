#!/usr/bin/env bun
/**
 * Packs every package into `.artifacts/`, in dependency order.
 *
 * A tarball is the one artifact that shows what a consumer actually receives,
 * so continuous integration builds them on every commit rather than only at a
 * release -- a file left out of `files` is a bug that only a tarball reveals.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, ".artifacts");

mkdirSync(OUT, { recursive: true });

const names = readdirSync(path.join(ROOT, "packages")).filter((n) =>
	existsSync(path.join(ROOT, "packages", n, "package.json")),
);

let failed = 0;
for (const name of names) {
	const dir = path.join(ROOT, "packages", name);
	const m = JSON.parse(
		readFileSync(path.join(dir, "package.json"), "utf8"),
	) as { name: string; private?: boolean };
	if (m.private === true) continue;

	const result = spawnSync("npm", ["pack", "--pack-destination", OUT], {
		cwd: dir,
		encoding: "utf8",
	});
	if (result.status === 0) {
		console.log(`  ok    ${m.name}`);
		continue;
	}
	failed++;
	console.log(`  FAIL  ${m.name}\n${result.stderr ?? ""}`);
}

if (failed > 0) process.exit(1);
console.log(`\npacked into ${path.relative(ROOT, OUT)}/`);
