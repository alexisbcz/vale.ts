#!/usr/bin/env bun
/**
 * Typechecks every package, in dependency order.
 *
 * `tsc -b` across the workspace would be the obvious way, but the packages
 * resolve each other through Bun's workspace links to `src/index.ts` rather
 * than through project references to built declarations -- so each is checked
 * on its own, with the others' sources in scope.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * The packages, leaves first.
 *
 * Checking in this order means the first error reported is the one closest to
 * its cause, rather than its consequence three packages downstream.
 */
const ORDER = [
	"models",
	"regex",
	"nlp",
	"spell",
	"tengo",
	"core",
	"check",
	"lint",
	"vale",
	"cli",
];

function packages(): string[] {
	const dir = path.join(ROOT, "packages");
	const present = readdirSync(dir).filter((n) =>
		existsSync(path.join(dir, n, "tsconfig.json")),
	);
	const known = ORDER.filter((n) => present.includes(n));
	const rest = present.filter((n) => !ORDER.includes(n)).sort();
	return [...known, ...rest];
}

let failed = 0;

for (const name of packages()) {
	const project = path.join("packages", name, "tsconfig.json");
	const result = spawnSync(
		"bunx",
		["tsc", "--noEmit", "-p", project, "--pretty", "false"],
		{ cwd: ROOT, encoding: "utf8" },
	);

	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.status === 0 && output === "") {
		console.log(`  ok    ${name}`);
		continue;
	}

	failed++;
	console.log(`  FAIL  ${name}`);
	console.log(
		output
			.split("\n")
			.map((l) => `        ${l}`)
			.join("\n"),
	);
}

// A package's own project covers its sources; the tests, the compatibility
// harness and these scripts are checked together, because they import across
// packages the way a consumer does.
{
	const result = spawnSync(
		"bunx",
		["tsc", "-p", "tsconfig.tests.json", "--pretty", "false"],
		{ cwd: ROOT, encoding: "utf8" },
	);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.status === 0 && output === "") {
		console.log("  ok    tests, harness and scripts");
	} else {
		failed++;
		console.log("  FAIL  tests, harness and scripts");
		console.log(
			output
				.split("\n")
				.map((l) => `        ${l}`)
				.join("\n"),
		);
	}
}

if (failed > 0) {
	console.log(`\n${failed} project(s) do not typecheck`);
	process.exit(1);
}
console.log("\neverything typechecks");
