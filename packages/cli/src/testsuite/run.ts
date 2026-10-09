/**
 * Running the cases a configuration keeps beside its rules.
 *
 * Two modes. An isolated case names a rule and loads nothing else -- not the
 * rest of the style, not the project's configuration -- so it says exactly what
 * the rule does. A case without a rule runs under the configuration a `vale`
 * run in that directory would use, which is what tells you whether the rule
 * reaches real documents at all.
 */

import {
	checkName,
	fileExists,
	findConfigAsset,
	getPackages,
	isDir,
	newConfig,
	newFlags,
	newView,
	readPipeline,
	styleName,
	VIEW_DIR,
	type CLIFlags,
} from "@vale-ts/core";
import { Manager } from "@vale-ts/check";
import { createLinter, type Linter } from "@vale-ts/lint";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Case } from "./suite.ts";
import { caseExt } from "./suite.ts";

/** What running one case produced. */
export interface Result {
	case: Case;

	/**
	 * The alert output, one `line:col:check:message` per line. There is no
	 * path: the document was a string.
	 */
	got: string;

	/** Why the case failed, or `""` when it passed. */
	reason: string;

	/**
	 * Why the case could not be run at all. A rule that does not compile is not
	 * a failing assertion.
	 */
	err: Error | null;
}

/** Whether the case did not pass, for either reason. */
export function failed(r: Result): boolean {
	return r.reason !== "" || r.err !== null;
}

/** Installs packages into a `StylesPath`, the way `vale sync` does. */
export type Install = (
	pkgs: readonly string[],
	styles: string,
) => Promise<void>;

/** Lints the cases in a configuration. */
export class Runner {
	/**
	 * With this, a package's own `Packages` are installed for its isolated
	 * cases, so a rule that extends another package resolves without a synced
	 * project.
	 */
	install: Install | null = null;

	/**
	 * The linter a `vale` run in this directory would use. Built once and
	 * reused: loading a configuration costs more than linting the handful of
	 * lines a case holds.
	 */
	private project: Linter | null = null;

	/**
	 * The configuration's `StylesPath` search list, read once and only for
	 * naming isolated rules. Empty when there is no configuration, which is
	 * fine: isolation never needed one.
	 */
	private paths: string[] = [];
	private pathsRead = false;

	/** The extra search paths found for each package root. */
	private readonly deps = new Map<string, string[]>();
	/** The directories `install` wrote into. */
	private readonly temp: string[] = [];

	constructor(private readonly flags: CLIFlags) {}

	/** Removes the packages installed for the run. */
	close(): void {
		for (const dir of this.temp) {
			rmSync(dir, { recursive: true, force: true });
		}
		this.temp.length = 0;
	}

	/** Lints one case and compares what came back. */
	async run(c: Case): Promise<Result> {
		try {
			const got = await this.lint(c);
			return { case: c, got, reason: compare(c, got), err: null };
		} catch (err) {
			return {
				case: c,
				got: "",
				reason: "",
				err: err instanceof Error ? err : new Error(String(err)),
			};
		}
	}

	/** The search paths `--coverage` names a rule against. */
	searchPaths(): string[] {
		if (!this.pathsRead) {
			this.pathsRead = true;
			try {
				this.paths = readPipeline(this.flags, false).searchPaths();
			} catch {
				// A directory of cases with no `.vale.ini` anywhere is a
				// supported way to run; naming falls back to the rule's parent
				// directory there.
				this.paths = [];
			}
		}
		return this.paths;
	}

	/** Converts a case's input and returns its alerts, one per line. */
	private async lint(c: Case): Promise<string> {
		const linter = await this.linterFor(c);
		linter.manager.config.flags.inExt = caseExt(c);

		let out = "";
		for (const f of linter.lintString(c.input)) {
			for (const a of f.sortedAlerts()) {
				out += `${a.line}:${a.span[0]}:${a.check}:${a.message}\n`;
			}
		}
		return out;
	}

	/** The linter a case runs under. */
	private async linterFor(c: Case): Promise<Linter> {
		if (c.rule !== "") {
			return isolate(c, await this.isolatedSearch(c));
		}

		if (this.project === null) {
			this.project = createLinter(
				Manager.create(readPipeline(this.flags, false)),
			);
		}
		return this.project;
	}

	/**
	 * Orders the search paths for an isolated case: installed dependencies
	 * first, then the project's paths, and the rule's own package last, since
	 * the last path is the `StylesPath` its dictionaries are read from.
	 */
	private async isolatedSearch(c: Case): Promise<string[]> {
		const pkg = await this.packagePaths(c);
		if (pkg.length === 0) return this.searchPaths();

		const own = pkg[0] as string;
		const search = pkg.slice(1);
		for (const sp of this.searchPaths()) {
			if (path.resolve(sp) !== own) search.push(sp);
		}
		search.push(own);
		return search;
	}

	/**
	 * The search paths a rule's package brings: its own `styles` directory
	 * first, then a `StylesPath` holding the packages its `.vale.ini` declares
	 * that the search paths do not already have.
	 *
	 * A package root is the nearest directory above the rule with both a
	 * `.vale.ini` and a `styles` directory, the layout `vale sync` installs.
	 */
	private async packagePaths(c: Case): Promise<string[]> {
		const rule = path.resolve(
			path.isAbsolute(c.rule) ? c.rule : path.join(path.dirname(c.path), c.rule),
		);

		const root = packageRoot(path.dirname(rule));
		if (root === "") return [];

		const cached = this.deps.get(root);
		if (cached !== undefined) return cached;

		const styles = path.join(root, "styles");
		const paths = [styles];

		const pkgs = getPackages(path.join(root, ".vale.ini"));
		const missing = pkgs.filter(
			(pkg) => !onPath(baseName(pkg), [styles, ...this.searchPaths()]),
		);

		if (missing.length > 0 && this.install !== null) {
			const dir = mkdtempSync(path.join(tmpdir(), "vale-test-"));
			this.temp.push(dir);
			await this.install(missing, dir);
			paths.push(dir);
		}

		this.deps.set(root, paths);
		return paths;
	}
}

/** A package name without its extension, the way `sync` names one. */
function baseName(pkg: string): string {
	const base = path.basename(pkg);
	const ext = path.extname(base);
	return ext === "" ? base : base.slice(0, -ext.length);
}

/** Walks up from `dir` to the nearest package root, or `""`. */
function packageRoot(dir: string): string {
	let at = dir;
	for (;;) {
		if (fileExists(path.join(at, ".vale.ini")) && isDir(path.join(at, "styles"))) {
			return at;
		}
		const parent = path.dirname(at);
		if (parent === at) return "";
		at = parent;
	}
}

/** Whether a style named `name` is installed on a search path. */
function onPath(name: string, search: readonly string[]): boolean {
	return search.some((sp) => isDir(path.join(sp, name)));
}

/**
 * Builds a linter holding one rule and nothing else.
 *
 * The rule keeps the name a project run would give it -- found under a search
 * path, that is its full path under the style root (`Std.dates.TimeFormat`);
 * otherwise the parent directory is the style. Either way a case can be moved
 * between the two modes without its `want` changing.
 */
export function isolate(c: Case, search: readonly string[]): Linter {
	const rule = path.isAbsolute(c.rule)
		? c.rule
		: path.join(path.dirname(c.path), c.rule);

	const name = isolatedName(rule, search);
	const style = styleName(name);

	const cfg = newConfig(newFlags());

	// Every severity, since an isolated rule is being asked what it matches and
	// not whether a run would show it.
	cfg.minAlertLevel = 0;
	cfg.gBaseStyles = [style];

	// A rule that extends another rule resolves its parent against the search
	// paths; isolation changes what runs, not what a reference means.
	for (const sp of search) cfg.addStylesPath(sp);

	// A View is attached to every file of the case's format, which is what a
	// section would do; it has to be there before the rule compiles, since a
	// rule's `in` is checked against the Views that exist.
	if (c.view !== "") {
		const viewPath = findConfigAsset(cfg, `${c.view}.yml`, VIEW_DIR);
		if (viewPath === "") {
			throw new Error(
				`${path.basename(c.path)}: "${c.name}": view '${c.view}' not found ` +
					"under config/views on the search path",
			);
		}
		cfg.views[`*${caseExt(c)}`] = newView(viewPath);
	}

	const linter = createLinter(Manager.create(cfg));
	linter.manager.addRuleFromFile(name, rule);
	return linter;
}

/** Names the rule at `file` the way a project run would. */
export function isolatedName(file: string, search: readonly string[]): string {
	const abs = path.resolve(file);

	for (const sp of search) {
		const root = path.resolve(sp);
		const rel = path.relative(root, abs);

		// Not under this search path, or sitting directly in it with no style
		// directory to take a name from.
		if (rel.startsWith("..") || !rel.includes(path.sep)) continue;

		const first = rel.split(path.sep)[0] as string;
		try {
			return checkName(path.join(root, first), abs);
		} catch {
			continue;
		}
	}

	const style = path.basename(path.dirname(file));
	const base = path.basename(file).split(".")[0] as string;
	return `${style}.${base}`;
}

/** Why a case failed, or `""` when it passed. */
export function compare(c: Case, got: string): string {
	if (c.want !== null && got.trim() !== c.want.trim()) {
		return "output does not match";
	}

	for (const want of c.contains) {
		if (!got.includes(want)) {
			return `output does not contain ${JSON.stringify(want)}`;
		}
	}

	for (const absent of c.absent) {
		if (got.includes(absent)) {
			return `output contains ${JSON.stringify(absent)}`;
		}
	}

	return "";
}
