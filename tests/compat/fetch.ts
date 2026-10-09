#!/usr/bin/env bun
/**
 * Fetches what the compatibility suite compares against.
 *
 * Two things: Vale's own `testdata/` at a pinned commit, which is the corpus
 * and the expectations both, and the release binary that corpus belongs to, so
 * the suite can run the two implementations side by side on the same inputs.
 *
 * Neither is committed here. The corpus is 30 MB of someone else's fixtures,
 * and the binary is 55 MB of someone else's build; pinning them and fetching on
 * demand says the same thing with none of the weight.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import {
	CORPUS_COMMIT,
	REFERENCE_VERSION,
	referenceAsset,
	UPSTREAM,
} from "./pinned.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);

/** Where the corpus and the binary are kept, and which is gitignored. */
export const CACHE = path.join(HERE, ".cache");
export const TESTDATA = path.join(CACHE, "testdata");
export const REFERENCE = path.join(
	CACHE,
	"bin",
	process.platform === "win32" ? "vale.exe" : "vale",
);

/** A file recording what is in the cache, so a stale one is replaced. */
const STAMP = path.join(CACHE, "stamp.json");

interface Stamp {
	commit: string;
	version: string;
}

function readStamp(): Stamp {
	try {
		return JSON.parse(readFileSync(STAMP, "utf8")) as Stamp;
	} catch {
		return { commit: "", version: "" };
	}
}

function writeStamp(stamp: Stamp): void {
	writeFileSync(STAMP, `${JSON.stringify(stamp, null, "\t")}\n`);
}

/** Whether the corpus is present and at the pinned commit. */
export function hasCorpus(): boolean {
	return existsSync(TESTDATA) && readStamp().commit === CORPUS_COMMIT;
}

/** Whether the reference binary is present and at the pinned version. */
export function hasReference(): boolean {
	return existsSync(REFERENCE) && readStamp().version === REFERENCE_VERSION;
}

/**
 * Clones the corpus at the pinned commit.
 *
 * A sparse, shallow clone of `testdata/` alone: the whole repository is 170 MB
 * of Go, and none of it is needed here.
 */
export function fetchCorpus(): void {
	if (hasCorpus()) return;

	mkdirSync(CACHE, { recursive: true });
	const work = path.join(CACHE, "upstream");
	rmSync(work, { recursive: true, force: true });

	run("git", ["init", "--quiet", work]);
	run("git", ["-C", work, "remote", "add", "origin", UPSTREAM]);
	run("git", ["-C", work, "config", "core.sparseCheckout", "true"]);
	writeFileSync(path.join(work, ".git", "info", "sparse-checkout"), "testdata/\n");
	run("git", [
		"-C",
		work,
		"fetch",
		"--quiet",
		"--depth",
		"1",
		"origin",
		CORPUS_COMMIT,
	]);
	run("git", ["-C", work, "checkout", "--quiet", "FETCH_HEAD"]);

	rmSync(TESTDATA, { recursive: true, force: true });
	run("cp", ["-R", path.join(work, "testdata"), TESTDATA]);
	rmSync(work, { recursive: true, force: true });

	writeStamp({ ...readStamp(), commit: CORPUS_COMMIT });
}

/** Downloads the pinned release binary for this platform. */
export async function fetchReference(): Promise<void> {
	if (hasReference()) return;

	const bin = path.dirname(REFERENCE);
	mkdirSync(bin, { recursive: true });

	const asset = referenceAsset(process.platform, process.arch);
	const response = await fetch(asset.url);
	if (!response.ok) {
		throw new Error(`downloading ${asset.name}: ${response.status}`);
	}

	const archive = path.join(bin, asset.name);
	writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));

	if (asset.name.endsWith(".zip")) {
		run("unzip", ["-o", "-q", archive, "-d", bin]);
	} else {
		run("tar", ["xzf", archive, "-C", bin]);
	}
	rmSync(archive, { force: true });

	writeStamp({ ...readStamp(), version: REFERENCE_VERSION });
}

function run(cmd: string, args: readonly string[]): void {
	const result = spawnSync(cmd, args, { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`${cmd} ${args.join(" ")}: ${result.stderr || result.stdout || result.error?.message}`,
		);
	}
}

if (import.meta.main) {
	fetchCorpus();
	console.log(`corpus:    ${TESTDATA} @ ${CORPUS_COMMIT.slice(0, 12)}`);

	if (process.argv.includes("--reference")) {
		await fetchReference();
		console.log(`reference: ${REFERENCE} @ v${REFERENCE_VERSION}`);
	}
}
