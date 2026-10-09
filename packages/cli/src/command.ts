/**
 * The subcommands of `vale`, and everything their help says.
 *
 * `summary`, `usage` and `detail` are one table rather than three so that a
 * command cannot be listed without being documented, or documented without
 * being reachable -- which is how `fix` came to be described in the help and
 * hidden from it at the same time.
 *
 * `dump-config` is not a command: `ls-config` prints the configuration, and
 * `dc` is its hidden alias.
 */

import { readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { Manager, parseAlert } from "@vale-ts/check";
import type { CLIFlags, Config } from "@vale-ts/core";
import {
	CONFIG_VARS,
	defaultConfig,
	defaultStylesPath,
	fileExists,
	isDir,
	mockLoad,
	newConfig,
	newE100,
	newFile,
	newFlags,
	readPipeline,
} from "@vale-ts/core";
import { createLinter } from "@vale-ts/lint";
import { fetchArchive } from "./api.ts";
import { applyFixes } from "./apply.ts";
import { configJSON } from "./config-json.ts";
import { printJSONAlerts } from "./json.ts";
import {
	execName,
	installNativeHost,
	nativeConfig,
	uninstallNativeHost,
} from "./native.ts";
import { println, stdout } from "./out.ts";
import { syncCommand } from "./sync.ts";
import { textToContext } from "./tag.ts";
import { code, foundMark, missingMark, renderTable } from "./term.ts";
import { runTests } from "./test.ts";
import { getJSON, printJSON, sendResponse } from "./util.ts";

/** One subcommand. */
export interface Command {
	/** Does the work. */
	run: (args: string[], flags: CLIFlags) => void | Promise<void>;

	/** The single line the listing in `vale --help` shows. */
	summary: string;

	/** The invocation, without the leading `vale`. */
	usage?: string;

	/**
	 * What `vale <command> --help` adds. Empty is fine for a command whose
	 * summary says all there is to say.
	 */
	detail?: string;

	/**
	 * Keeps a command out of the listing and out of the suggestions, without
	 * making it any less reachable for whoever knows the name.
	 */
	hidden?: boolean;
}

/** A rule's compiled regex, as `compile` prints it. */
interface CompiledRule {
	Pattern: string;
}

export const COMMANDS: Record<string, Command> = {
	"ls-config": {
		run: printConfig,
		summary: "Print the current configuration to stdout.",
		usage: "ls-config",
		detail:
			"Resolves the configuration the way a lint run would -- every\n" +
			"source, in order -- and prints the result. This is the fastest way\n" +
			"to see which styles and rules a directory actually has in scope.",
	},
	"ls-metrics": {
		run: printMetrics,
		summary: "Print the given file's internal metrics to stdout.",
		usage: "ls-metrics <file>",
		detail:
			"Reports the counts Vale computed while reading the file --\n" +
			"words, sentences, paragraphs, and the elements of its markup.",
	},
	"ls-dirs": {
		run: printDirs,
		summary: "Print the default configuration directories to stdout.",
		usage: "ls-dirs",
		detail:
			"Shows where Vale looks for a StylesPath, a `.vale.ini`, and the\n" +
			"native messaging host, and whether each one is there.",
	},
	"ls-vars": {
		run: printVars,
		summary: "Print the supported environment variables to stdout.",
		usage: "ls-vars",
		detail: "Lists every variable Vale reads, what it does, and its current value.",
	},
	sync: {
		run: syncCommand,
		summary: "Download and install external configuration sources.",
		usage: "sync",
		detail:
			"Reads the `Packages` key of the active configuration and installs\n" +
			"each entry into the StylesPath. Run this after adding a package,\n" +
			"and in CI before linting.",
	},
	test: {
		run: runTests,
		summary: "Run the test cases kept beside a configuration's rules.",
		usage: "test [path...]",
		detail:
			"Cases live in a rule's `tests` list or in a `.test.yml` file. A\n" +
			"package's own `Packages` are installed for the run, so a rule that\n" +
			"extends another package resolves without `vale sync`.\n\n" +
			"With --coverage, every rule found under the given paths has to\n" +
			"produce an alert in at least one case. A rule that matches nothing\n" +
			"passes its cases silently, and this is what tells you.",
	},

	// Private: the API surface the editor integrations and the native host use.
	// Reachable by name, absent from the help.
	"host-install": {
		run: installNativeHost,
		summary: "Install the native messaging host.",
		hidden: true,
	},
	"host-uninstall": {
		run: uninstallNativeHost,
		summary: "Uninstall the native messaging host.",
		hidden: true,
	},
	compile: {
		run: compileRule,
		summary: "Print a rule's compiled pattern.",
		hidden: true,
	},
	run: {
		run: runRule,
		summary: "Run a single rule against a file.",
		hidden: true,
	},
	transform: {
		run: transform,
		summary: "Print a file after its transform.",
		hidden: true,
	},
	"ls-path": {
		run: pathInfo,
		summary: "Print the configuration files in scope.",
		hidden: true,
	},
	fix: {
		run: fix,
		summary: "Attempt to automatically fix the given alert.",
		usage: "fix <alert> | fix --apply <path>...",
		hidden: true,
	},
	tag: {
		run: runTag,
		summary: "Print a file's part-of-speech tags.",
		hidden: true,
	},
	dc: {
		run: printConfig,
		summary: "Alias for `ls-config`.",
		hidden: true,
	},
	load: {
		run: loadConfigs,
		summary: "Print a merged pair of configurations.",
		hidden: true,
	},
	install: {
		run: install,
		summary: "Install a package from a URL.",
		hidden: true,
	},
};

/** The commands the help lists, in order. */
export function visibleCommandNames(): string[] {
	return Object.entries(COMMANDS)
		.filter(([, cmd]) => cmd.hidden !== true)
		.map(([name]) => name)
		.sort();
}

// --- the commands ---------------------------------------------------------

function printConfig(_args: string[], flags: CLIFlags): void {
	// `cfg.String()` in Go, which is `json.MarshalIndent(cfg, "", "  ")`.
	println(getJSON(configJSON(readPipeline(flags, false))));
}

function printMetrics(args: string[]): void {
	if (args.length !== 1) {
		throw newE100("ls-metrics", new Error("one argument expected"));
	}
	const target = args[0] as string;
	if (!fileExists(target)) throw new Error("file not found");

	const cfg = newConfig(newFlags());
	cfg.minAlertLevel = 0;
	cfg.gBaseStyles = ["Vale"];
	cfg.flags.inExt = ".txt"; // default value

	const linter = createLinter(Manager.create(cfg));
	const linted = linter.lint([target], "*");

	// `fileExists` is true for a directory, and a directory that holds no
	// lintable file lints to nothing. Reporting that is better than printing
	// `{}`, which already means "a file Vale read and found no metrics in".
	const first = linted[0];
	if (first === undefined) {
		throw newE100(
			"ls-metrics",
			new Error(`'${target}' contains no lintable files`),
		);
	}

	const computed = first.computeMetrics();
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(computed)) {
		// A score carries the digits of its division; two places is what a
		// rule's message shows.
		out[k] = Number.isInteger(v) ? v : Math.round(v * 100) / 100;
	}

	printJSON(sortedRecord(out));
}

function compileRule(args: string[]): void {
	if (args.length !== 1) {
		throw newE100("compile", new Error("one argument expected"));
	}

	const cfg = newConfig(newFlags());
	const rulePath = args[0] as string;
	const name = path.basename(rulePath);

	const mgr = Manager.create(cfg);
	mgr.addRuleFromFile(name, rulePath);

	const rule = mgr.rules().get(name);
	const compiled: CompiledRule = { Pattern: rule?.pattern() ?? "" };
	printJSON(compiled);
}

function runRule(args: string[]): void {
	if (args.length !== 2) {
		throw newE100("run", new Error("two arguments expected"));
	}

	const cfg = newConfig(newFlags());
	cfg.minAlertLevel = 0;
	cfg.gBaseStyles = ["Test"];
	cfg.flags.inExt = ".txt"; // default value

	const linter = createLinter(Manager.create(cfg));
	linter.manager.addRuleFromFile("Test.Rule", args[0] as string);

	printJSONAlerts(linter.lint([args[1] as string], "*"));
}

function printVars(_args: string[], flags: CLIFlags): void {
	if (flags.output === "JSON") {
		const out: Record<string, string> = {};
		for (const name of Object.keys(CONFIG_VARS)) {
			out[name] = process.env[name] ?? "";
		}
		printJSON(sortedRecord(out));
		return;
	}

	const rows: string[][] = [["Variable", "Description", "Value"]];
	for (const [name, info] of Object.entries(CONFIG_VARS)) {
		const value = process.env[name];
		rows.push([code(name), info, value === undefined ? missingMark() : value]);
	}

	stdout(renderTable(rows));
}

function printDirs(_args: string[], flags: CLIFlags): void {
	const styles = defaultStylesPath();
	const cfg = defaultConfig();

	const native = nativeConfig();
	const nativeExe = path.join(path.dirname(native), execName("vale-native"));

	if (flags.output === "JSON") {
		printJSON(
			sortedRecord({
				StylesPath: styles,
				".vale.ini": cfg,
				"vale-native": nativeExe,
			}),
		);
		return;
	}

	const rows: string[][] = [
		["Asset", "Default Location", "Found"],
		[code("StylesPath"), styles, isDir(styles) ? foundMark() : missingMark()],
		[code(".vale.ini"), cfg, fileExists(cfg) ? foundMark() : missingMark()],
		[
			code("vale-native"),
			nativeExe,
			fileExists(native) ? foundMark() : missingMark(),
		],
	];

	stdout(renderTable(rows));
}

function transform(args: string[], flags: CLIFlags): void {
	if (args.length !== 1) {
		throw newE100("transform", new Error("one argument expected"));
	}
	const target = args[0] as string;
	if (!fileExists(target)) throw new Error(`file not found: ${target}`);

	const cfg = readPipeline(flags, false);
	const linter = createLinter(Manager.create(cfg));

	println(linter.transform(newFile(target, cfg)));
}

function pathInfo(_args: string[], flags: CLIFlags): void {
	const cfg = readPipeline(flags, false);
	printJSON({ configs: cfg.configFiles });
}

function loadConfigs(args: string[]): void {
	if (args.length !== 2) {
		throw newE100("run", new Error("two arguments expected"));
	}

	const cfg = newConfig(newFlags());
	cfg.rootINI = args[0] as string;

	cfg.addConfigFile(args[0] as string);
	cfg.addConfigFile(args[1] as string);

	mockLoad(args[0] as string, args[1] as string, cfg);
	printJSON(configJSON(cfg));
}

function runTag(args: string[]): void {
	if (args.length !== 3) {
		throw newE100("tag", new Error("three arguments expected"));
	}

	const text = readFileSync(args[0] as string, "utf8");
	printJSON(
		textToContext(text, { lang: args[1] as string, endpoint: args[2] as string }),
	);
}

/** `vale fix <alert>`, or `vale fix --apply <path>...`. */
function fix(args: string[], flags: CLIFlags): void {
	if (flags.apply) {
		applyFixes(args, flags);
		return;
	}

	if (args.length !== 1) {
		throw newE100("fix", new Error("one argument expected"));
	}

	let alert = args[0] as string;
	if (fileExists(alert)) alert = readFileSync(alert, "utf8");

	const cfg = readPipeline(flags, false);
	printJSON(parseAlert(alert, cfg));
}

async function install(args: string[], flags: CLIFlags): Promise<void> {
	const cfg: Config = readPipeline(flags, false);

	const style = path.join(cfg.stylesPath(), args[0] ?? "");
	// Remove any existing version before unpacking the new one.
	if (isDir(style)) rmSync(style, { recursive: true, force: true });

	const url = args[1] ?? "";
	try {
		await fetchArchive(url, cfg.stylesPath());
	} catch (err) {
		sendResponse(`Failed to install '${url}'`, err);
		return;
	}

	sendResponse(`Successfully installed '${url}'`, null);
}

/** A record with its keys in the order a Go map marshals them. */
function sortedRecord<T>(value: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(value).sort()) out[key] = value[key] as T;
	return out;
}
