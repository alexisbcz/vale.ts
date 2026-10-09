/**
 * Reading DITA, through the DITA Open Toolkit.
 *
 * The toolkit is slow -- about four seconds a file -- and almost all of that
 * is starting it. So a run converts every DITA file it will lint in one go,
 * through a map written in their common directory, and a run of many files
 * costs about what one did. `prepareDITA` does that; `lintDITA` reads what it
 * left behind, and falls back to a run of its own for a file the map run did
 * not produce.
 *
 * The toolkit reads from disk rather than from standard input, so a file an
 * ignore pattern rewrites is converted from a copy written beside it, where
 * its conrefs still resolve.
 *
 * `prepareDITA` is not called by the linter: `Linter.lint` is the engine and
 * is not ours to change. A caller that lints a directory of DITA calls it
 * first, with the same inputs, and the cache it fills is consulted here.
 */

import type { Config, File } from "@vale-ts/core";
import {
	formatFromExt,
	newE100,
	newE201FromPosition,
	newFile,
	shouldIgnoreDirectory,
	toSlash,
	walk,
	which,
} from "@vale-ts/core";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** What a DITA reader needs from the linter. */
export interface DITAHost {
	config: Config;
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
}

/**
 * What the toolkit made of each DITA file, by absolute path.
 *
 * Filled by `prepareDITA` and emptied by `clearDITA`; a file that is not here
 * is converted on its own.
 */
const ditaHTML = new Map<string, string>();

/** Forgets what `prepareDITA` converted. */
export function clearDITA(): void {
	ditaHTML.clear();
}

function absPath(p: string): string {
	try {
		return path.resolve(p);
	} catch {
		return p;
	}
}

/** The flags every toolkit run passes. */
function ditaArgs(input: string, outDir: string): string[] {
	return [
		"-i",
		input,
		"-f",
		"html5",
		"-o",
		outDir,
		// This run's own temporary directory, so two runs never share one.
		"-t",
		path.join(outDir, "temp"),
		"--nav-toc=none",
		// Lets a DITA file reference files outside its own directory, which is
		// what a conref does.
		"--outer.control=quiet",
	];
}

/** Reads a DITA file. */
export function lintDITA(host: DITAHost, f: File): void {
	const cached = ditaHTML.get(absPath(f.path));
	if (cached !== undefined) {
		lintDITAHTML(host, f, cached);
		return;
	}

	const dita = which(["dita", "dita.bat"]);
	if (dita === "") {
		throw newE100(f.path, new Error("dita not found; it's needed to read DITA"));
	}

	let tempDir: string;
	try {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "dita-"));
	} catch (err) {
		throw newE201FromPosition(
			err instanceof Error ? err.message : String(err),
			f.path,
			1,
		);
	}

	const cleanup: string[] = [];
	try {
		// The toolkit reads the file from disk, so ignore patterns are applied
		// to a copy beside it, where its conrefs still resolve.
		let input = f.path;
		const rewritten = host.transform(f);
		if (rewritten !== f.content) {
			const copied = path.join(
				path.dirname(f.path),
				`.vale-${process.pid}-${Date.now()}.dita`,
			);
			try {
				writeFileSync(copied, rewritten, "utf8");
			} catch (err) {
				throw newE100(f.path, err);
			}
			cleanup.push(copied);
			input = copied;
		}

		const run = spawnSync(dita, ditaArgs(input, tempDir), { encoding: "utf8" });
		if (run.status !== 0) {
			// The toolkit's own diagnostics are far more useful than its exit
			// status, but it does not always write any.
			const msg = (run.stderr ?? "").trim();
			if (msg !== "") throw newE100(f.path, new Error(msg));
			throw newE100(
				f.path,
				run.error instanceof Error ? run.error : new Error("dita failed"),
			);
		}

		const want = `${path.basename(input, path.extname(input))}.html`;
		// Also looks in subdirectories, in case an "outer" file was referenced,
		// which `--outer.control=quiet` allows.
		const found = findFile(tempDir, want);
		if (found === null) {
			throw newE100(path.join(tempDir, want), new Error("no HTML was produced"));
		}

		let data: string;
		try {
			data = readFileSync(found, "utf8");
		} catch (err) {
			throw newE100(found, err);
		}
		lintDITAHTML(host, f, data);
	} finally {
		for (const p of cleanup) rmSync(p, { force: true });
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/** Lints the toolkit's HTML for a file, without its head. */
export function lintDITAHTML(host: DITAHost, f: File, data: string): void {
	const head1 = data.indexOf("<head>");
	const head2 = data.indexOf("</head>");

	const html =
		head1 >= 0 && head2 >= 0 ? data.slice(0, head1) + data.slice(head2) : data;

	host.lintHTMLTokens(f, html, 0);
}

/** The first file named `name` under `root`, or null. */
function findFile(root: string, name: string): string | null {
	let found: string | null = null;
	const stack = [root];
	for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const p = path.join(dir, entry);
			let isDir: boolean;
			try {
				isDir = statSync(p).isDirectory();
			} catch {
				continue;
			}
			if (isDir) stack.push(p);
			else if (entry === name) found = p;
		}
	}
	return found;
}

/**
 * Converts every DITA file the run will lint in one toolkit run.
 *
 * Nothing is done for fewer than two files -- one file costs the same either
 * way -- or when the files share no directory to write the map into. A failure
 * at any step leaves the cache empty, and each file is then converted on its
 * own.
 */
export function prepareDITA(host: DITAHost, input: readonly string[]): void {
	const paths = ditaInputs(host, input);
	if (paths.length < 2) return;

	const dita = which(["dita", "dita.bat"]);
	if (dita === "") return;

	const base = commonDir(paths);
	if (base === "") return;

	let outDir: string;
	try {
		outDir = mkdtempSync(path.join(os.tmpdir(), "dita-"));
	} catch {
		return;
	}

	const cleanup: string[] = [];
	try {
		// A file an ignore pattern changes is converted from a copy beside it.
		const converted = new Map<string, string>();
		for (const p of paths) {
			let f: File;
			try {
				f = newFile(p, host.config);
			} catch {
				continue;
			}
			let input = p;
			try {
				const rewritten = host.transform(f);
				if (rewritten !== f.content) {
					const copied = path.join(
						path.dirname(p),
						`.vale-${process.pid}-${converted.size}.dita`,
					);
					writeFileSync(copied, rewritten, "utf8");
					cleanup.push(copied);
					input = copied;
				}
			} catch {
				continue;
			}
			converted.set(p, input);
		}

		const mapFile = path.join(base, `.vale-${process.pid}.ditamap`);
		cleanup.push(mapFile);

		let body = '<?xml version="1.0" encoding="UTF-8"?>\n';
		body += '<!DOCTYPE map PUBLIC "-//OASIS//DTD DITA Map//EN" "map.dtd">\n<map>\n';
		for (const p of paths) {
			const input = converted.get(p);
			if (input === undefined) continue;
			body += `<topicref href="${toSlash(path.relative(base, absPath(input)))}"/>\n`;
		}
		body += "</map>\n";

		try {
			writeFileSync(mapFile, body, "utf8");
		} catch {
			return;
		}

		const run = spawnSync(dita, ditaArgs(mapFile, outDir), { encoding: "utf8" });
		if (run.status !== 0) return;

		for (const [p, input] of converted) {
			const rel = path.relative(base, absPath(input));
			const html = path.join(
				outDir,
				`${rel.slice(0, rel.length - path.extname(rel).length)}.html`,
			);
			try {
				ditaHTML.set(absPath(p), readFileSync(html, "utf8"));
			} catch {
				// A file the map run did not produce falls back to its own run.
			}
		}
	} finally {
		for (const p of cleanup) rmSync(p, { force: true });
		rmSync(outDir, { recursive: true, force: true });
	}
}

/**
 * The DITA files the run will lint, walked as the run walks them.
 *
 * The run's `--glob` is not consulted: it lives on the linter, which is not
 * ours to reach into. Converting a file the run then skips costs a little
 * time in the one toolkit run and nothing else, which is the right way round
 * -- missing one would cost that file a four-second run of its own.
 */
function ditaInputs(host: DITAHost, input: readonly string[]): string[] {
	const found: string[] = [];
	const styles = new Set(host.config.paths.map((p) => path.resolve(p)));

	for (const root of input) {
		walk(root, (entry) => {
			if (entry.isDirectory) {
				if (
					shouldIgnoreDirectory(entry.path) ||
					(entry.path !== root && styles.has(path.resolve(entry.path)))
				) {
					return false;
				}
				return true;
			}
			const [ext] = formatFromExt(entry.path, host.config.formats);
			if (ext === ".dita") found.push(entry.path);
			return true;
		});
	}
	return found;
}

/** The deepest directory holding every path, or "" if they share none. */
export function commonDir(paths: readonly string[]): string {
	let dir = path.dirname(absPath(paths[0]));
	for (;;) {
		let all = true;
		for (const p of paths) {
			if (!absPath(p).startsWith(dir + path.sep)) {
				all = false;
				break;
			}
		}
		if (all) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return "";
		dir = parent;
	}
}
