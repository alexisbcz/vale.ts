#!/usr/bin/env bun
/**
 * Checks that every package carries the version a tag claims.
 *
 * The packages are released together, so a tag that does not match one of them
 * would publish a set that disagrees with itself about what it is.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const want = process.argv[2];

if (want === undefined || want === "") {
	console.error("usage: check-version.ts <version>");
	process.exit(2);
}

let wrong = 0;
for (const name of readdirSync(path.join(ROOT, "packages"))) {
	const manifest = path.join(ROOT, "packages", name, "package.json");
	if (!existsSync(manifest)) continue;
	const m = JSON.parse(readFileSync(manifest, "utf8")) as {
		name: string;
		version: string;
		private?: boolean;
	};
	if (m.private === true) continue;
	if (m.version !== want) {
		console.error(`${m.name} is ${m.version}, but the tag says ${want}`);
		wrong++;
	}
}

if (wrong > 0) process.exit(1);
console.log(`every package is ${want}`);
