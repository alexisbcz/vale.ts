#!/usr/bin/env bun
/**
 * Builds every package for publication.
 *
 * In this repository a package's entry point is its TypeScript source, which is
 * what makes `bun test` and a cross-package import work with no build step.
 * That is not what belongs on a registry, so each package is bundled to ESM
 * with its declarations beside it, and `publishConfig` is what points a
 * consumer at `dist/` -- leaving `main` pointing at `src/` for anyone working
 * in the repository.
 *
 * Workspace siblings and npm dependencies stay external: a consumer installing
 * `@vale-ts/lint` should get one copy of `@vale-ts/core`, not one per package
 * that uses it.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

interface Manifest {
	name: string;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

function manifest(dir: string): Manifest {
	return JSON.parse(
		readFileSync(path.join(dir, "package.json"), "utf8"),
	) as Manifest;
}

/** Every dependency a package declares, which the bundle leaves alone. */
function externals(m: Manifest): string[] {
	return [
		...Object.keys(m.dependencies ?? {}),
		...Object.keys(m.peerDependencies ?? {}),
		// The built-ins, which `--target=node` already externalizes, named here
		// so that a package forgetting to declare one still builds.
		"node:*",
	];
}

/** Puts a Node shebang on a built command, replacing Bun's if it survived. */
function shebang(file: string): void {
	const built = readFileSync(file, "utf8");
	const body = built.startsWith("#!")
		? built.slice(built.indexOf("\n") + 1)
		: built;
	writeFileSync(file, `#!/usr/bin/env node\n${body}`);
}

const names = readdirSync(path.join(ROOT, "packages")).filter((n) =>
	existsSync(path.join(ROOT, "packages", n, "src", "index.ts")),
);

let failed = 0;

for (const name of names) {
	const dir = path.join(ROOT, "packages", name);
	const m = manifest(dir);

	rmSync(path.join(dir, "dist"), { recursive: true, force: true });
	// The projects are `composite`, so `tsc` consults its build log before it
	// emits -- and a log left from a build whose `dist/` has since been removed
	// says there is nothing to do. Clearing it is what makes a build from
	// scratch actually emit the declarations.
	rmSync(path.join(dir, "tsconfig.tsbuildinfo"), { force: true });

	// A package with a `main.ts` is a command, and its bundle has to be a file
	// Node can run: the source's shebang names Bun, so the built one names the
	// runtime a consumer installing from a registry actually has.
	const entries = ["src/index.ts"];
	if (existsSync(path.join(dir, "src", "main.ts"))) entries.push("src/main.ts");

	const bundle = spawnSync(
		"bun",
		[
			"build",
			...entries,
			"--outdir",
			"dist",
			"--target",
			"node",
			"--format",
			"esm",
			...externals(m).flatMap((e) => ["--external", e]),
		],
		{ cwd: dir, encoding: "utf8" },
	);

	if (bundle.status === 0 && entries.length > 1) {
		shebang(path.join(dir, "dist", "main.js"));
	}

	const types = spawnSync(
		"bunx",
		[
			"tsc",
			"-p",
			"tsconfig.json",
			"--declaration",
			"--emitDeclarationOnly",
			"--outDir",
			"dist",
			"--pretty",
			"false",
		],
		{ cwd: dir, encoding: "utf8" },
	);

	const problems = [
		bundle.status === 0 ? "" : `bundle: ${bundle.stderr ?? ""}`,
		types.status === 0 ? "" : `types: ${types.stdout ?? ""}${types.stderr ?? ""}`,
	].filter((s) => s !== "");

	if (problems.length === 0) {
		console.log(`  ok    ${m.name}`);
		continue;
	}

	failed++;
	console.log(`  FAIL  ${m.name}`);
	for (const p of problems) {
		console.log(
			p
				.trim()
				.split("\n")
				.map((l) => `        ${l}`)
				.join("\n"),
		);
	}
}

if (failed > 0) {
	console.log(`\n${failed} package(s) did not build`);
	process.exit(1);
}
console.log(`\nbuilt ${names.length} package(s)`);
