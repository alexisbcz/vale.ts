/**
 * Picking the release of a package this Vale can actually use.
 *
 * A package declares the Vale it needs in its `meta.json`, as `vale_version`,
 * and its earlier releases either as a `releases` manifest, each with its own
 * floor and archive URL, or by a `feed` of them. Sync reads all three: when the
 * release it fetched needs a newer Vale than this one, the newest release that
 * this Vale supports is installed instead -- picked from the manifest on any
 * host, or, for a package served from a GitHub latest-release URL, found by
 * walking the feed.
 *
 * When nothing fits, the fetched release is installed with a warning, which is
 * what sync always did. The metadata can only ever improve on that: a floor
 * mistyped too high must not turn into a package nobody can install.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Meta, Release } from "./api.ts";
import { fetchArchive, tempDir } from "./api.ts";
import { compareVersions, parseConstraint, parseVersion, satisfies } from "./semver.ts";
import { pkgRoot } from "./sync.ts";
import { printInfo, printWarning } from "./term.ts";
import { version } from "./version.ts";

/**
 * The path GitHub serves a repository's newest release asset under, which is
 * how the package library names every package.
 */
const LATEST_RELEASE = "/releases/latest/download/";

/** How many releases back sync looks for one it supports. */
const RELEASE_WALK = 10;

/** Reads the `meta.json` of the package under `dir`, or nothing. */
export function pkgMeta(dir: string, name: string): Meta {
	try {
		const raw = readFileSync(
			path.join(dir, pkgRoot(dir, name), "meta.json"),
			"utf8",
		);
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" ? (parsed as Meta) : {};
	} catch {
		return {};
	}
}

/**
 * Whether this Vale meets a package's `vale_version`.
 *
 * A development build, `master`, meets every floor, as does a floor that is
 * missing or that cannot be read: a package's metadata is not a reason to
 * refuse it.
 */
export function supportsVale(constraint: string | undefined): boolean {
	const text = (constraint ?? "").trim();
	if (text === "" || version() === "master") return true;

	const parsed = parseConstraint(text);
	if (parsed === null) return true;

	const v = parseVersion(version());
	if (v === null) return true;

	return satisfies(parsed, v);
}

/**
 * Orders a manifest newest first by version, leaving entries whose version does
 * not parse where the author put them, after the rest.
 */
export function sortedReleases(releases: readonly Release[]): Release[] {
	return [...releases]
		.map((release, index) => ({ release, index }))
		.sort((a, b) => {
			const vi = parseVersion(a.release.version);
			const vj = parseVersion(b.release.version);
			if (vi === null || vj === null) {
				if (vi !== null && vj === null) return -1;
				if (vi === null && vj !== null) return 1;
				return a.index - b.index;
			}
			const cmp = compareVersions(vj, vi);
			return cmp !== 0 ? cmp : a.index - b.index;
		})
		.map((entry) => entry.release);
}

/** Lists a package's releases, newest first, from its Atom feed. */
export async function releaseTags(feed: string): Promise<string[]> {
	const resp = await fetch(feed);
	if (!resp.ok) {
		throw new Error(
			`could not fetch '${feed}' (status code '${resp.status}')`,
		);
	}

	// A feed is a few kilobytes; one that is not stops here.
	const body = (await resp.text()).slice(0, 1 << 20);

	const tags: string[] = [];
	for (const match of body.matchAll(/<entry\b([\s\S]*?)<\/entry>/g)) {
		const entry = match[1] ?? "";

		// GitHub's entries carry the tag at the end of both the id and the
		// link, `.../releases/tag/v0.1.1`.
		const link = /<link[^>]*\bhref="([^"]*)"/.exec(entry);
		const id = /<id>([^<]*)<\/id>/.exec(entry);
		const ref = link?.[1] ?? id?.[1] ?? "";
		if (ref === "") continue;

		const tag = ref.slice(ref.lastIndexOf("/") + 1);
		if (tag !== "") tags.push(tag);
	}

	return tags;
}

/**
 * The directory to install the package from: `dir`, where `url` was unpacked,
 * when this Vale supports what is there, or else a release from the package's
 * feed that it does support.
 */
export async function supportedRelease(
	name: string,
	url: string,
	dir: string,
): Promise<string> {
	const meta = pkgMeta(dir, name);
	if (supportsVale(meta.vale_version)) return dir;

	const need = `'${name}' needs Vale ${meta.vale_version}; this is ${version()}`;
	const manifest = meta.releases ?? [];
	const candidates: Release[] = [];

	if (manifest.length > 0) {
		// A manifest names each release and what it needs, so the one to
		// install is known before anything else is downloaded, on any host.
		for (const rel of sortedReleases(manifest)) {
			if (supportsVale(rel.vale_version) && rel.url !== "" && rel.url !== url) {
				candidates.push(rel);
			}
		}
	} else if (url.includes(LATEST_RELEASE)) {
		// Without one, a GitHub latest-release URL has a feed to walk.
		const feed =
			meta.feed !== undefined && meta.feed !== ""
				? meta.feed
				: `${url.split(LATEST_RELEASE)[0]}/releases.atom`;

		let tags: string[];
		try {
			tags = await releaseTags(feed);
		} catch (err) {
			printWarning(
				`${need}, and its releases could not be read: ${
					err instanceof Error ? err.message : String(err)
				}.`,
			);
			return dir;
		}

		for (const tag of tags.slice(0, RELEASE_WALK)) {
			candidates.push({
				version: tag,
				url: url.replace(LATEST_RELEASE, `/releases/download/${tag}/`),
			});
		}
	}

	for (const rel of candidates) {
		const tmp = tempDir(name);
		try {
			await fetchArchive(rel.url, tmp);
		} catch {
			continue;
		}
		// A manifest entry has stated its floor; a feed entry is checked from
		// the archive it came in.
		if (manifest.length > 0 || supportsVale(pkgMeta(tmp, name).vale_version)) {
			printInfo(`${need}: installed ${rel.version} instead.`);
			return tmp;
		}
	}

	// Nothing fits, or the URL is pinned: what was asked for is installed, as
	// it always was, and the user knows what it needs.
	printWarning(`${need}.`);
	return dir;
}
