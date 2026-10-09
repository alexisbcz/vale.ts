/**
 * `vale-ts` -- Vale, the prose linter, as a TypeScript library.
 *
 * This is the layer that assembles the others: it reads a configuration, builds
 * the rules from it, registers the readers, and gives you something to lint
 * with. The pieces underneath are published separately and usable on their own
 * (see the repository's README), but almost every caller wants this one.
 *
 * ```ts
 * import { Vale } from "vale-ts";
 *
 * const vale = await Vale.fromConfig();
 * for (const file of vale.lintFile("docs/guide.md")) {
 *   for (const alert of file.sortedAlerts()) {
 *     console.log(`${file.path}:${alert.line}:${alert.span[0]}: ${alert.message}`);
 *   }
 * }
 * ```
 */

import { Manager } from "@vale-ts/check";
import type { Alert, CLIFlags, Config, File } from "@vale-ts/core";
import {
	fromString as configFromString,
	newConfig,
	newFlags,
	readPipeline,
} from "@vale-ts/core";
import { createLinter, initCode, type Linter } from "@vale-ts/lint";

export { Manager } from "@vale-ts/check";
export type * from "@vale-ts/core";
export {
	ALERT_LEVELS,
	Block,
	Config,
	File,
	Glob,
	LEVEL_TO_INT,
	newFlags,
	ValeError,
} from "@vale-ts/core";
export { createLinter, DocumentErrors, Linter } from "@vale-ts/lint";

/** How a string is linted when it is not a file on disk. */
export interface LintStringOptions {
	/**
	 * The path to pretend the text came from.
	 *
	 * Which rules apply depends on the path -- `[*.md]` matches a Markdown file
	 * -- so a caller linting an editor buffer should say what it is.
	 */
	path?: string;
	/** The extension to read the text as, when there is no path. */
	ext?: string;
}

/**
 * A configured linter.
 *
 * Build one with `fromConfig`, which reads `.vale.ini` the way the command line
 * does, or with `fromString`, which takes the configuration as text -- useful
 * for a language server, a test, or anything that has no project on disk.
 */
export class Vale {
	readonly config: Config;
	readonly manager: Manager;
	readonly linter: Linter;

	private constructor(config: Config, manager: Manager, linter: Linter) {
		this.config = config;
		this.manager = manager;
		this.linter = linter;
	}

	/**
	 * Reads the configuration through Vale's own search: the project's
	 * `.vale.ini`, then the user's, then anything a package shipped.
	 */
	static async fromConfig(flags: Partial<CLIFlags> = {}): Promise<Vale> {
		const config = readPipeline(newFlags(flags), false);
		return Vale.fromConfigObject(config);
	}

	/**
	 * Reads the configuration from text rather than from disk.
	 *
	 * A relative `StylesPath` resolves against the working directory, since
	 * there is no configuration file to resolve it against.
	 */
	static async fromString(
		ini: string,
		flags: Partial<CLIFlags> = {},
	): Promise<Vale> {
		const config = newConfig(newFlags(flags));
		configFromString(ini, config, false);
		return Vale.fromConfigObject(config);
	}

	/** Builds a linter from a configuration already in hand. */
	static async fromConfigObject(config: Config): Promise<Vale> {
		const manager = await Manager.create(config);
		// Loading the tree-sitter grammars is the one asynchronous step in the
		// whole engine; doing it here keeps every lint call synchronous.
		await initCode();
		const linter = createLinter(manager);
		return new Vale(config, manager, linter);
	}

	/** Lints a file, or every file under a directory. */
	lintFile(path: string, glob = "*"): File[] {
		return this.linter.lint([path], glob);
	}

	/** Lints several paths, which may be files or directories. */
	lintPaths(paths: readonly string[], glob = "*"): File[] {
		return this.linter.lint(paths, glob);
	}

	/** Lints text that is not on disk. */
	lintString(text: string, options: LintStringOptions = {}): File[] {
		const flags = this.config.flags;
		const path = flags.inPath;
		const ext = flags.inExt;
		if (options.path !== undefined) flags.inPath = options.path;
		if (options.ext !== undefined) flags.inExt = options.ext;
		try {
			return this.linter.lintString(text);
		} finally {
			flags.inPath = path;
			flags.inExt = ext;
		}
	}
}

/**
 * Lints one path with the configuration Vale would find, and returns the alerts
 * with the file each came from.
 *
 * The shortest thing that is still useful; reach for `Vale` when you want to
 * lint more than once, since this builds the rules each time it is called.
 */
export async function lint(
	path: string,
	flags: Partial<CLIFlags> = {},
): Promise<Array<Alert & { path: string }>> {
	const vale = await Vale.fromConfig(flags);
	const out: Array<Alert & { path: string }> = [];
	for (const file of vale.lintFile(path)) {
		for (const alert of file.sortedAlerts()) {
			out.push({ ...alert, path: file.path });
		}
	}
	return out;
}

/** Lints text with the configuration Vale would find. */
export async function lintText(
	text: string,
	options: LintStringOptions = {},
	flags: Partial<CLIFlags> = {},
): Promise<Array<Alert & { path: string }>> {
	const vale = await Vale.fromConfig(flags);
	const out: Array<Alert & { path: string }> = [];
	for (const file of vale.lintString(text, options)) {
		for (const alert of file.sortedAlerts()) {
			out.push({ ...alert, path: file.path });
		}
	}
	return out;
}
