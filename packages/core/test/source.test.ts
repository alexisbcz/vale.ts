/**
 * Which configuration files a run reads, and in which order.
 *
 * Ported from `internal/core/source_test.go`.
 *
 * Go's tests change directory to the real home directory and rely on its not
 * holding a `.vale.ini`; these point `HOME`, `XDG_CONFIG_HOME` and
 * `XDG_DATA_HOME` at directories the test owns and work from an empty one, so
 * the answer does not depend on the machine. The working directory is restored
 * afterwards.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
	fromFile,
	newConfig,
	newFlags,
	PIPE_DIR,
	readPipeline,
} from "../src/config.ts";

const KNOWN_CONFIG = nodePath.join(
	import.meta.dir,
	"fixtures",
	"formats",
	".vale.ini",
);

/** The variables that decide where a configuration is looked for. */
const OWNED = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"VALE_CONFIG_PATH",
	"VALE_STYLES_PATH",
];

let saved: Record<string, string | undefined> = {};
let cwd = "";
let root = "";

function tempDir(): string {
	return mkdtempSync(nodePath.join(tmpdir(), "vale-source-"));
}

beforeEach(() => {
	cwd = process.cwd();
	saved = {};
	for (const name of OWNED) {
		saved[name] = process.env[name];
		delete process.env[name];
	}

	root = tempDir();
	process.env.HOME = root;
	process.env.XDG_CONFIG_HOME = nodePath.join(root, "config");
	process.env.XDG_DATA_HOME = nodePath.join(root, "data");

	// A directory without a project-specific config file.
	process.chdir(tempDir());
});

afterEach(() => {
	process.chdir(cwd);
	for (const name of OWNED) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
});

/** Writes the default config file and returns its path. */
function onlyDefaultConfig(): string {
	const defaultCfg = nodePath.join(root, "config", "vale", ".vale.ini");
	mkdirSync(nodePath.dirname(defaultCfg), { recursive: true });
	writeFileSync(defaultCfg, "StylesPath = styles\nPackages = write-good\n");
	return defaultCfg;
}

// An error is raised when no base config can be found.
test("no base config is an error", () => {
	const cfg = newConfig(newFlags({ ignoreGlobal: true }));

	expect(() => fromFile(cfg, false)).toThrow();
});

/**
 * A dry run -- `vale sync` -- succeeds when the user's only config file is the
 * default one.
 *
 * See https://github.com/errata-ai/vale/issues/1128.
 */
test("a dry run works from the default config alone", () => {
	const defaultCfg = onlyDefaultConfig();

	const cfg = newConfig(newFlags({}));
	fromFile(cfg, true);

	// `sync` reads its packages from the root config file.
	expect(cfg.root()).toBe(defaultCfg);

	// `sync` also has to write to the `StylesPath` that linting reads from.
	expect(cfg.stylesPath()).toBe(
		nodePath.join(nodePath.dirname(defaultCfg), "styles"),
	);
});

// `--no-global` leaves a dry run without a root config, rather than falling
// back to the file it just excluded.
test("--no-global leaves a dry run without a root", () => {
	onlyDefaultConfig();

	const cfg = newConfig(newFlags({ ignoreGlobal: true }));
	fromFile(cfg, true);

	expect(() => cfg.root()).toThrow();
});

// The `--config` option sets the base config.
test("--config sets the base config", () => {
	const cfg = newConfig(newFlags({ path: KNOWN_CONFIG }));

	expect(() => fromFile(cfg, true)).not.toThrow();
	expect(cfg.root()).toBe(KNOWN_CONFIG);
});

// `VALE_CONFIG_PATH` sets the base config.
test("VALE_CONFIG_PATH sets the base config", () => {
	process.env.VALE_CONFIG_PATH = KNOWN_CONFIG;

	const cfg = newConfig(newFlags({}));

	expect(() => fromFile(cfg, true)).not.toThrow();
	expect(cfg.root()).toBe(KNOWN_CONFIG);
});

/**
 * A package's `.vale.ini` keeps its own `StylesPath`. Read from the pipeline
 * directory, that path resolved to a directory beside the file and became the
 * last path, where the next sync then installed.
 */
test("a package's StylesPath is dropped", () => {
	const project = tempDir();
	const styles = nodePath.join(project, "styles");
	const pipe = nodePath.join(styles, PIPE_DIR);
	mkdirSync(pipe, { recursive: true });

	writeFileSync(
		nodePath.join(pipe, "0-pkg.ini"),
		"StylesPath = styles\n\n[*]\nBasedOnStyles = A\n",
	);
	const cfgPath = nodePath.join(project, ".vale.ini");
	writeFileSync(cfgPath, "StylesPath = styles\n");

	const cfg = readPipeline(newFlags({ path: cfgPath, ignoreGlobal: true }), false);

	expect(cfg.paths).toEqual([styles]);
	expect(cfg.gBaseStyles, "the package's other settings should still load").toEqual(
		["A"],
	);
});
