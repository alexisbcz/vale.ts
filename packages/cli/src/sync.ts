/**
 * `vale sync`: installing the packages a configuration asks for.
 *
 * A package is a URL, a name the library knows, a local directory or a local
 * `.zip`, and each one lands in the `StylesPath` the same way: its `styles`
 * directory is merged in, its `config` subdirectories are merged rather than
 * replaced, and its own `.vale.ini` is copied into the pipeline directory under
 * an indexed name so that the order the packages were declared in survives.
 */

import { cpSync, readdirSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import type { Config } from "@vale-ts/core";
import {
	type CLIFlags,
	CONFIG_DIRS,
	fileExists,
	fileNameWithoutExt,
	getPackages,
	isDir,
	isPhrase,
	mkdir,
	newE100,
	PIPE_DIR,
	readPipeline,
} from "@vale-ts/core";
import { downloadError, fetchArchive, tempDir } from "./api.ts";
import { inLibrary } from "./library.ts";
import { println } from "./out.ts";
import { supportedRelease } from "./pkgver.ts";
import { newProgress, printSuccess } from "./term.ts";
import { unarchive } from "./unarchive.ts";

/** Prepares the `StylesPath` for a sync, clearing the pipeline directory. */
export function initPath(cfg: Config): void {
	// The first entry is always the default `StylesPath`.
	const stylesPath = cfg.stylesPath();

	if (!isDir(stylesPath)) {
		try {
			mkdir(stylesPath);
		} catch {
			throw newE100(
				"sync",
				new Error(`unable to initialize StylesPath (value = '${stylesPath}')`),
			);
		}
	}

	try {
		rmSync(path.join(stylesPath, PIPE_DIR), { recursive: true, force: true });
	} catch (err) {
		throw newE100("sync", err);
	}
}

/** Installs one package, whatever form it was declared in. */
export async function readPkg(
	pkg: string,
	stylesPath: string,
	idx: number,
): Promise<void> {
	if (isPhrase(pkg) && !isDir(pkg)) {
		const entry = await inLibrary(pkg);
		if (entry !== "") {
			await download(pkg, entry, stylesPath, idx);
			return;
		}
	}
	await loadPkg(fileNameWithoutExt(pkg), pkg, stylesPath, idx);
}

async function loadPkg(
	name: string,
	urlOrPath: string,
	styles: string,
	index: number,
): Promise<void> {
	let info: ReturnType<typeof statSync> | null = null;
	try {
		info = statSync(urlOrPath);
	} catch {
		info = null;
	}

	if (info !== null) {
		if (info.isDirectory()) {
			// A directory package is installed from its parent, so that the
			// directory itself is the entry that gets copied.
			await installPkg(path.dirname(urlOrPath), name, styles, index);
			return;
		}
		const dir = tempDir(name);
		unarchive(urlOrPath, dir);
		await installPkg(dir, name, styles, index);
		return;
	}

	await download(name, urlOrPath, styles, index);
}

/** Fetches a remote package and installs the release this Vale supports. */
export async function download(
	name: string,
	url: string,
	styles: string,
	index: number,
): Promise<void> {
	let dir = tempDir(name);

	try {
		await fetchArchive(url, dir);
	} catch (err) {
		throw downloadError(url, err);
	}

	// The release that landed may need a newer Vale than this one; see
	// `pkgver.ts` for the one that gets installed instead.
	dir = await supportedRelease(name, url, dir);

	await installPkg(dir, name, styles, index);
}

/**
 * The entry in `dir` that holds the package named `name`: an exact match, or
 * failing that one that differs only in case.
 *
 * A remote package is named after its URL, and GitHub serves a release asset
 * under any casing of its name, so the directory inside the archive may not
 * match. See #1181.
 */
export function pkgRoot(dir: string, name: string): string {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return name;
	}

	if (entries.includes(name)) return name;

	const lower = name.toLowerCase();
	for (const entry of entries) {
		if (entry.toLowerCase() === lower) return entry;
	}

	return name;
}

/** Copies one unpacked package into the `StylesPath`. */
export async function installPkg(
	dir: string,
	nameArg: string,
	styles: string,
	index: number,
): Promise<void> {
	const name = pkgRoot(dir, nameArg);

	const root = path.join(dir, name);
	const stylesDir = path.join(root, "styles");
	const pipe = path.join(styles, PIPE_DIR);
	const cfg = path.join(root, ".vale.ini");

	if (!isDir(stylesDir) && !fileExists(cfg)) {
		moveAsset(name, dir, styles); // style-only
		return;
	}

	if (isDir(stylesDir)) {
		moveDir(stylesDir, styles);

		// `$StylesPath/config` is treated differently from the rest of the
		// entries on the path: its contents are merged with what is already
		// there rather than replacing it.
		for (const sub of CONFIG_DIRS) {
			const from = path.join(stylesDir, sub);
			if (isDir(from)) moveDir(from, path.join(styles, sub));
		}
	}

	if (fileExists(cfg)) {
		for (const [idx, pkg] of getPackages(cfg).entries()) {
			await readPkg(pkg, styles, idx);
		}

		// The package's `.vale.ini` is copied into the pipeline directory under
		// its indexed name. It must not be renamed in place: for a local
		// directory package, `root` is the user's own source directory, so
		// renaming would clobber their `.vale.ini`. See #991 and #583.
		const dst = path.join(pipe, `${index}-${name}.ini`);
		rmSync(dst, { recursive: true, force: true });
		mkdir(pipe);
		cpSync(cfg, dst);
	}
}

/** Copies every entry of `oldPath` into `newPath`, leaving `config` alone. */
function moveDir(oldPath: string, newPath: string): void {
	for (const entry of readdirSync(oldPath, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name !== "config") {
			moveAsset(entry.name, oldPath, newPath);
		}
	}
}

/** Replaces one entry of `newPath` with the one `oldPath` holds. */
function moveAsset(name: string, oldPath: string, newPath: string): void {
	const src = path.join(oldPath, name);
	const dst = path.join(newPath, name);

	if (fileExists(dst) || isDir(dst)) {
		rmSync(dst, { recursive: true, force: true });
	}

	mkdir(newPath);
	cpSync(src, dst, { recursive: true });
}

/** Installs `pkgs` into `styles`, as `vale sync` would. */
export async function installPackages(
	pkgs: readonly string[],
	styles: string,
): Promise<void> {
	for (const [idx, pkg] of pkgs.entries()) {
		await readPkg(pkg, styles, idx);
	}
}

/** `vale sync`. */
export async function syncCommand(
	_args: readonly string[],
	flags: CLIFlags,
): Promise<void> {
	const cfg = readPipeline(flags, true);

	// Sync should only ever run for a single config file. It is resolved before
	// the `StylesPath` is touched, so that a missing config reports itself
	// rather than the empty path it leaves behind.
	let rootINI: string;
	try {
		rootINI = cfg.root();
	} catch (err) {
		throw newE100("sync", err);
	}

	initPath(cfg);

	const pkgs = getPackages(rootINI);
	const stylesPath = cfg.stylesPath();

	// A progress bar is for someone watching it. Redirected into a CI log it
	// leaves a trail of redrawn frames and, at the end, no record of what was
	// actually installed -- so `--plain-progress` swaps it for a line per
	// package. See #1138.
	//
	// Asked for rather than inferred: a run that has been piped somewhere for
	// years should keep printing what it always printed.
	const bar = flags.plainProgress ? null : newProgress(pkgs.length);

	for (const [idx, pkg] of pkgs.entries()) {
		const name = fileNameWithoutExt(pkg);

		if (bar !== null) {
			bar.update(`Syncing ${name}`);
			bar.increment();
		}

		await readPkg(pkg, stylesPath, idx);

		if (bar === null) println(`Synced ${name}`);
	}

	bar?.stop();
	printSuccess(`Synced ${pkgs.length} package(s) to '${stylesPath}'.`);
}
