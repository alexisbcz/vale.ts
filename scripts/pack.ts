#!/usr/bin/env bun
/**
 * Packs every package into `.artifacts/`, in dependency order.
 *
 * A tarball is the one artifact that shows what a consumer actually receives,
 * so continuous integration builds them on every commit rather than only at a
 * release -- a file left out of `files` is a bug that only a tarball reveals,
 * and so is a `workspace:*` that never became a version range.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import {
	packageDirs,
	ROOT,
	readManifest,
	withPublishableManifest,
} from "./manifest.ts";

const OUT = path.join(ROOT, ".artifacts");

mkdirSync(OUT, { recursive: true });

let failed = 0;
let packed = 0;

for (const dir of packageDirs()) {
	const m = readManifest(dir);
	if (m.private === true) continue;

	const result = withPublishableManifest(dir, () =>
		spawnSync("npm", ["pack", "--pack-destination", OUT], {
			cwd: dir,
			encoding: "utf8",
		}),
	);

	if (result.status === 0) {
		packed++;
		console.log(`  ok    ${m.name}`);
		continue;
	}
	failed++;
	console.log(`  FAIL  ${m.name}\n${result.stderr ?? ""}`);
}

if (failed > 0) process.exit(1);
console.log(`\npacked ${packed} package(s) into ${path.relative(ROOT, OUT)}/`);
