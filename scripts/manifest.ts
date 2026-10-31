/**
 * Reading and rewriting the packages' manifests.
 *
 * In the repository a sibling is depended on as `workspace:*`, which is what
 * makes `bun install` link the source rather than fetch a release. That
 * specifier is not a version range, so a registry cannot resolve it and `npm`
 * refuses to install a tarball carrying one. Whatever leaves this repository
 * therefore has to name a real range, and the range has to be the version in
 * this repository right now -- the packages are released together, and a
 * sibling's published shape is the one that was built beside it.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const ROOT = path.resolve(
	path.dirname(new URL(import.meta.url).pathname),
	"..",
);

/** The packages, leaves first, so a dependency is handled before its users. */
export const ORDER = [
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

export interface Manifest {
	name: string;
	version: string;
	private?: boolean;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

/** Every package directory with a manifest, leaves first. */
export function packageDirs(): string[] {
	const dir = path.join(ROOT, "packages");
	const present = readdirSync(dir).filter((n) =>
		existsSync(path.join(dir, n, "package.json")),
	);
	const known = ORDER.filter((n) => present.includes(n));
	const rest = present.filter((n) => !ORDER.includes(n)).sort();
	return [...known, ...rest].map((n) => path.join(dir, n));
}

export function readManifest(dir: string): Manifest {
	return JSON.parse(
		readFileSync(path.join(dir, "package.json"), "utf8"),
	) as Manifest;
}

/** The version each workspace package is at, by package name. */
export function workspaceVersions(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const dir of packageDirs()) {
		const m = readManifest(dir);
		out[m.name] = m.version;
	}
	return out;
}

const DEP_FIELDS = [
	"dependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

/**
 * Runs `body` with the manifest's `workspace:` specifiers replaced by the
 * ranges a consumer can resolve and its `publishConfig` applied, and puts the
 * manifest back afterwards.
 *
 * The file is restored byte for byte, including its formatting, because it is
 * a tracked file and a release should not show up as a diff.
 */
export function withPublishableManifest<T>(dir: string, body: () => T): T {
	const file = path.join(dir, "package.json");
	const original = readFileSync(file, "utf8");
	const versions = workspaceVersions();
	const m = JSON.parse(original) as Manifest & Record<string, unknown>;

	let changed = false;

	// The tree points at `src` so the repository runs without a build. npm only
	// honours `publishConfig` at publish time, so a tarball installed any other
	// way would hand its consumers raw TypeScript. Apply it here instead.
	const publish = m.publishConfig as Record<string, unknown> | undefined;
	if (publish) {
		for (const field of ["main", "types", "exports", "bin"]) {
			if (publish[field] !== undefined) {
				m[field] = publish[field];
				changed = true;
			}
		}
	}

	for (const field of DEP_FIELDS) {
		const deps = m[field];
		if (deps === undefined) continue;
		for (const [name, range] of Object.entries(deps)) {
			if (!range.startsWith("workspace:")) continue;
			const version = versions[name];
			if (version === undefined) {
				throw new Error(
					`${m.name} depends on ${name}, which is not a package here`,
				);
			}
			// `workspace:*` means "whatever is here", which for a consumer is
			// the version that was here: a caret range off it, so a patch
			// released later still satisfies it.
			deps[name] = `^${version}`;
			changed = true;
		}
	}

	if (!changed) return body();

	writeFileSync(file, `${JSON.stringify(m, null, "\t")}\n`);
	try {
		return body();
	} finally {
		writeFileSync(file, original);
	}
}
