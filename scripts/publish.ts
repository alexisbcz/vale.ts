#!/usr/bin/env bun
/**
 * Publishes the packages, leaves first.
 *
 * The order matters only for the registry's benefit: a package whose
 * dependencies are already published resolves for anyone installing it in the
 * window before the rest arrive.
 *
 * A version already on the registry is skipped rather than failing the run, so
 * re-running a release that failed partway through finishes it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { ORDER, ROOT, withPublishableManifest } from "./manifest.ts";

let failed = 0;

for (const name of ORDER) {
	const dir = path.join(ROOT, "packages", name);
	if (!existsSync(path.join(dir, "package.json"))) continue;

	const m = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
		name: string;
		version: string;
		private?: boolean;
	};
	if (m.private === true) continue;

	const probe = spawnSync("npm", ["view", `${m.name}@${m.version}`, "version"], {
		encoding: "utf8",
	});
	if (probe.status === 0 && (probe.stdout ?? "").trim() !== "") {
		console.log(`  skip  ${m.name}@${m.version} (already published)`);
		continue;
	}

	// The manifest on disk depends on its siblings as `workspace:*`, which no
	// registry can resolve; what is published names the versions instead.
	const result = withPublishableManifest(dir, () =>
		spawnSync("npm", ["publish", "--access", "public", "--provenance"], {
			cwd: dir,
			encoding: "utf8",
			stdio: "inherit",
		}),
	);
	if (result.status === 0) {
		console.log(`  ok    ${m.name}@${m.version}`);
		continue;
	}
	failed++;
	console.log(`  FAIL  ${m.name}@${m.version}`);
}

if (failed > 0) process.exit(1);
