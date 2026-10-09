/**
 * The configuration's defaults, and finding an asset on the search paths.
 *
 * Ported from `internal/core/config_test.go`. Go reads its fixtures from
 * `testdata/styles`; the handful these tests need are copied into
 * `test/fixtures/styles`.
 *
 * Each test points `XDG_DATA_HOME` at an empty directory, so the "default
 * styles path" is one the test owns rather than whatever the machine running
 * it has installed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
	defaultStylesPath,
	findAsset,
	ignoreFiles,
	newConfig,
	newFlags,
} from "../src/config.ts";
import { isDir } from "../src/system.ts";

const FIXTURES = nodePath.join(import.meta.dir, "fixtures");
const STYLES = nodePath.join(FIXTURES, "styles");

/** The variables that would otherwise decide where the defaults live. */
const OWNED = [
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"VALE_STYLES_PATH",
	"VALE_CONFIG_PATH",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = {};
	for (const name of OWNED) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	const root = mkdtempSync(nodePath.join(tmpdir(), "vale-config-"));
	process.env.XDG_DATA_HOME = nodePath.join(root, "data");
	process.env.XDG_CONFIG_HOME = nodePath.join(root, "config");
});

afterEach(() => {
	for (const name of OWNED) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
});

// In v3.0 the styles path has a default, and it is a directory: asking for the
// path is what reserves it, which is what lets `sync` write there.
test("a new configuration has a default StylesPath", () => {
	const path = newConfig(newFlags({})).stylesPath();

	expect(path).not.toBe("");
	expect(isDir(path), `${path} is not a directory`).toBe(true);
});

test("ignoreFiles finds every user-defined ignore list", () => {
	expect(ignoreFiles(STYLES)).toHaveLength(2);
});

describe("findAsset", () => {
	// Finding an asset on the user-specified StylesPath, which was the
	// standard behaviour in v2.0.
	test("on the user's StylesPath", () => {
		const cfg = newConfig(newFlags({}));
		cfg.addStylesPath(STYLES);

		expect(findAsset(cfg, "line.tmpl")).not.toBe("");
		expect(findAsset(cfg, "notfound")).toBe("");
	});

	// Finding an asset on the default StylesPath when there is no
	// user-specified one.
	test("on the default StylesPath", () => {
		const cfg = newConfig(newFlags({}));

		const target = nodePath.join(defaultStylesPath(), "tmp.tmpl");
		writeFileSync(target, "");
		try {
			expect(findAsset(cfg, "tmp.tmpl")).not.toBe("");
			expect(findAsset(cfg, "notfound")).toBe("");
		} finally {
			rmSync(target);
		}
	});

	// Falling back to the default StylesPath when there is a user-specified
	// one but the asset isn't there.
	test("falls back to the default StylesPath", () => {
		const cfg = newConfig(newFlags({}));
		cfg.addStylesPath(STYLES);

		const target = nodePath.join(defaultStylesPath(), "tmp.tmpl");
		writeFileSync(target, "");
		try {
			expect(findAsset(cfg, "tmp.tmpl"), `searched ${cfg.paths}`).not.toBe("");
		} finally {
			rmSync(target);
		}
	});
});
