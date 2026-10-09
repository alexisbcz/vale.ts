/**
 * The filesystem and platform helpers, ported from `internal/system`.
 *
 * Paths are kept as the caller wrote them -- with whatever separator the
 * platform uses -- and normalized to forward slashes only where something
 * compares them, which is what Go's `filepath.ToSlash` is doing at each of
 * those sites.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/** Whether anything exists at `filename`. */
export function fileExists(filename: string): boolean {
	if (filename === "") return false;
	try {
		// `existsSync` follows symlinks, which is what `os.Stat` does.
		return existsSync(filename);
	} catch {
		return false;
	}
}

/** Whether `filename` is a directory. */
export function isDir(filename: string): boolean {
	if (filename === "") return false;
	try {
		return statSync(filename).isDirectory();
	} catch {
		return false;
	}
}

/** Creates a directory and every parent it needs. */
export function mkdir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** The file's name without its extension. */
export function fileNameWithoutExt(fileName: string): string {
	const base = path.basename(fileName);
	const ext = path.extname(base);
	return ext === "" ? base : base.slice(0, -ext.length);
}

/** The absolute form of `p`. */
export function absPath(p: string): string {
	return path.isAbsolute(p) ? p : path.resolve(p);
}

/** Expands a leading `~` to the user's home directory. */
export function normalizePath(p: string): string {
	const home = homedir();
	if (home === "") return p;
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith(`~${path.sep}`)) {
		return path.join(home, p.slice(2));
	}
	return p;
}

/**
 * Resolves a path a configuration file named, relative to that file.
 *
 * An absolute path is returned as it is; a relative one is joined onto the
 * configuration file's directory, so `transform.xsl` beside a `.vale.ini` is
 * found whatever directory Vale was run from.
 */
export function determinePath(configPath: string, keyPath: string): string {
	const expanded = normalizePath(keyPath);
	let base = configPath;
	if (!isDir(base)) base = path.dirname(base);

	const abs = absPath(expanded);
	const rel = expanded.replace(new RegExp(`${escapeSep()}+$`), "");
	if (abs !== rel || !expanded.includes(path.sep)) {
		// The path was relative.
		return path.join(base, expanded);
	}
	return abs;
}

function escapeSep(): string {
	return path.sep === "\\" ? "\\\\" : "/";
}

/** The first of `cmds` that is on `PATH`, or "". */
export function which(cmds: readonly string[]): string {
	for (const cmd of cmds) {
		const probe = spawnSync(
			process.platform === "win32" ? "where" : "which",
			[cmd],
			{
				encoding: "utf8",
			},
		);
		if (probe.status === 0) {
			const first = (probe.stdout ?? "").split("\n")[0]?.trim();
			if (first) return first;
		}
	}
	return "";
}

/** The platform's name, in Go's spelling. */
export function osName(): string {
	switch (process.platform) {
		case "darwin":
			return "darwin";
		case "win32":
			return "windows";
		default:
			return process.platform;
	}
}

export function isMac(): boolean {
	return osName() === "darwin";
}

export function isWindows(): boolean {
	return osName() === "windows";
}

export function isLinux(): boolean {
	return osName() === "linux";
}

export function isUnix(): boolean {
	return isMac() || isLinux();
}

/**
 * The platform and architecture, spelled the way Vale's release assets are.
 *
 * `sync` builds a download URL from this, so the capitalization matters.
 */
export function platformAndArch(): string {
	const name = osName();
	const platform = name.charAt(0).toUpperCase() + name.slice(1);
	let arch = process.arch.toLowerCase();
	if (arch === "x64") arch = "x86_64";
	else if (arch === "amd64") arch = "x86_64";
	return `${platform}_${arch}`;
}

/** What a walk is told about each entry it visits. */
export interface WalkEntry {
	path: string;
	name: string;
	isDirectory: boolean;
	isFile: boolean;
}

/**
 * Walks a directory tree, following symlinks.
 *
 * A dangling symlink is skipped: there is nothing to lint behind it, so it
 * must not abort the walk. A symlink that fails to resolve for any other
 * reason -- a loop, say -- is an error that names the offending path, because
 * "too many links" on its own tells the user nothing.
 *
 * Returning `false` from `walkFn` for a directory skips its contents, which is
 * how the linter honours `--glob` without descending into `node_modules`.
 */
export function walk(
	root: string,
	walkFn: (entry: WalkEntry) => boolean | void,
): void {
	walkFrom(root, root, walkFn);
}

function walkFrom(
	real: string,
	reported: string,
	walkFn: (entry: WalkEntry) => boolean | void,
): void {
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(real);
	} catch {
		return;
	}

	if (info.isSymbolicLink()) {
		let target: string;
		try {
			target = realpathSync(real);
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code === "ENOENT") return; // dangling; nothing to lint
			throw new Error(`unable to resolve symlink '${reported}': ${String(err)}`);
		}
		let targetInfo: ReturnType<typeof lstatSync>;
		try {
			targetInfo = lstatSync(target);
		} catch {
			walkFn(entryOf(reported, false, true));
			return;
		}
		if (targetInfo.isDirectory()) {
			walkFrom(target, reported, walkFn);
			return;
		}
		walkFn(entryOf(reported, false, true));
		return;
	}

	if (!info.isDirectory()) {
		walkFn(entryOf(reported, false, true));
		return;
	}

	if (walkFn(entryOf(reported, true, false)) === false) return;

	let names: string[];
	try {
		names = readdirSync(real);
	} catch {
		return;
	}
	names.sort();
	for (const name of names) {
		walkFrom(path.join(real, name), path.join(reported, name), walkFn);
	}
}

function entryOf(p: string, dir: boolean, file: boolean): WalkEntry {
	return { path: p, name: path.basename(p), isDirectory: dir, isFile: file };
}

/** Whether `p` is a symbolic link. */
export function isSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Where a symbolic link points. */
export function readLink(p: string): string {
	return readlinkSync(p);
}

/**
 * The directories XDG says configuration and data belong in.
 *
 * Vale resolves its global configuration and its default `StylesPath` through
 * these, so a user who has set `XDG_CONFIG_HOME` finds their files where they
 * put them.
 */
export const xdg = {
	configHome(): string {
		const set = process.env.XDG_CONFIG_HOME;
		if (set && set !== "") return set;
		if (isWindows()) {
			return process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
		}
		if (isMac()) return path.join(homedir(), "Library", "Application Support");
		return path.join(homedir(), ".config");
	},

	dataHome(): string {
		const set = process.env.XDG_DATA_HOME;
		if (set && set !== "") return set;
		if (isWindows()) {
			return process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
		}
		if (isMac()) return path.join(homedir(), "Library", "Application Support");
		return path.join(homedir(), ".local", "share");
	},

	/** The path a configuration file would have, whether or not it exists. */
	configFile(rel: string): string {
		return reserve(path.join(xdg.configHome(), rel));
	},

	/** The path a data file would have, whether or not it exists. */
	dataFile(rel: string): string {
		return reserve(path.join(xdg.dataHome(), rel));
	},
};

/**
 * Makes sure the directory holding `file` exists, and returns `file`.
 *
 * `adrg/xdg`, which Go asks for these paths, creates the parent directory as
 * part of answering, and Vale leans on that: the default `StylesPath` is the
 * directory of `vale/styles/config.yml`, and a configuration carries it only
 * when it is a directory -- so without this a fresh install has no default
 * `StylesPath` at all, and `sync` has nowhere to write.
 */
function reserve(file: string): string {
	try {
		mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	} catch {
		// A read-only home is not a reason to refuse to lint; the caller tests
		// whether the path is a directory before using it.
	}
	return file;
}

/** `p` relative to the working directory when it is inside it. */
export function relToWD(p: string): string {
	try {
		const rel = path.relative(process.cwd(), p);
		if (!rel.startsWith("..")) return rel;
	} catch {
		// Fall through to the path as given.
	}
	return p;
}

export { path };
