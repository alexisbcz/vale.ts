/**
 * The command line, parsed the way `pflag` parses it.
 *
 * Go registers these against `pflag`, which accepts `--flag=value`,
 * `--flag value`, `--flag` for a boolean, grouped short forms (`-vh`), and
 * `--` to end flag parsing. Arguments and flags may be interspersed. All of
 * that is here, because a script that has been passing `--output JSON` for
 * years must keep working.
 *
 * The usage text is plain. These are described as they are declared, which is
 * before Vale knows where its output is going, so anything styled here would
 * still be styled when the help is piped into a file.
 */

import type { CLIFlags } from "@vale-ts/core";
import { newFlags } from "@vale-ts/core";

/** What kind of value a flag takes. */
export type FlagKind = "string" | "bool";

/** One declared flag. */
export interface FlagSpec {
	/** The long name, without the dashes. */
	name: string;
	/** The one-letter form, when there is one. */
	shorthand?: string;
	kind: FlagKind;
	/** The line the help listing shows. */
	usage: string;
	/** The field of `CLIFlags` it sets. */
	field: keyof CLIFlags;
}

/** The short forms, by long name. */
export const SHORTCODES: Record<string, string> = {
	version: "v",
	help: "h",
};

/**
 * Every flag Vale accepts.
 *
 * The two at the end are registered by `api.go` rather than `flag.go`; they are
 * one table here, since nothing depends on which file declared them.
 */
export const FLAGS: readonly FlagSpec[] = [
	{
		name: "sources",
		kind: "string",
		field: "sources",
		usage: "A list of config files to load.",
	},
	{
		name: "filter",
		kind: "string",
		field: "filter",
		usage: "An expression to filter rules by.",
	},
	{
		name: "glob",
		kind: "string",
		field: "glob",
		usage: "A glob pattern (--glob='*.{md,txt}').",
	},
	{
		name: "config",
		kind: "string",
		field: "path",
		usage: "A file path (--config='some/file/path/.vale.ini').",
	},
	{
		name: "output",
		kind: "string",
		field: "output",
		usage: 'An output style ("line", "JSON", or a template file).',
	},
	{
		name: "ext",
		kind: "string",
		field: "inExt",
		usage: "An extension to associate with stdin (--ext=.md).",
	},
	{
		name: "path",
		kind: "string",
		field: "inPath",
		usage: "A file path to associate with stdin (--path=docs/example.md).",
	},
	{
		name: "minAlertLevel",
		kind: "string",
		field: "alertLevel",
		usage: "The minimum level to display (--minAlertLevel=error).",
	},
	{
		name: "no-color",
		kind: "bool",
		field: "noColor",
		usage: "Don't colorize CLI output.",
	},
	{
		name: "plain-progress",
		kind: "bool",
		field: "plainProgress",
		usage: "Log each step instead of drawing a progress bar.",
	},
	{
		name: "no-wrap",
		kind: "bool",
		field: "wrap",
		usage: "Don't wrap CLI output.",
	},
	{
		name: "no-exit",
		kind: "bool",
		field: "noExit",
		usage: "Don't return a nonzero exit code on errors.",
	},
	{
		name: "counts",
		kind: "bool",
		field: "counts",
		usage: "Include per-check alert counts, zeros included, in JSON output.",
	},
	{
		name: "apply",
		kind: "bool",
		field: "apply",
		usage: "With `vale fix`: write every unambiguous fix back to disk.",
	},
	{
		name: "coverage",
		kind: "bool",
		field: "coverage",
		usage: "With `vale test`: fail when a rule produced no alert in any case.",
	},
	{
		name: "ignore-syntax",
		kind: "bool",
		field: "simple",
		usage: "Lint all files line-by-line.",
	},
	{
		name: "version",
		shorthand: "v",
		kind: "bool",
		field: "version",
		usage: "Print the current version.",
	},
	{
		name: "help",
		shorthand: "h",
		kind: "bool",
		field: "help",
		usage: "Print this help message.",
	},
	{
		name: "mode-compat",
		kind: "bool",
		field: "local",
		usage: "Prioritize local Vale configurations.",
	},
	{
		name: "sort",
		kind: "bool",
		field: "sorted",
		usage: "Sort files by their name in output.",
	},
	{
		name: "normalize",
		kind: "bool",
		field: "normalize",
		usage: "Replace each path separator with a slash ('/').",
	},
	{
		name: "relative",
		kind: "bool",
		field: "relative",
		usage: "Return relative paths.",
	},
	{
		name: "no-global",
		kind: "bool",
		field: "ignoreGlobal",
		usage: "Don't load the global configuration.",
	},
	{
		name: "mode-rev-compat",
		kind: "bool",
		field: "remote",
		usage: "Prioritize remote Vale configurations.",
	},
	{
		name: "built",
		kind: "string",
		field: "built",
		usage: "A post-processed file path.",
	},
];

const BY_NAME = new Map(FLAGS.map((f) => [f.name, f]));
const BY_SHORTHAND = new Map(
	FLAGS.filter((f) => f.shorthand !== undefined).map((f) => [
		f.shorthand as string,
		f,
	]),
);

/** What a parse produced. */
export interface ParseResult {
	flags: CLIFlags;
	/** The positional arguments, in the order they were given. */
	args: string[];
}

/** A command line `pflag` would reject, with the message it would print. */
export class FlagError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FlagError";
	}
}

/** `strconv.ParseBool`, which is what a boolean flag's value goes through. */
function parseBool(spec: FlagSpec, raw: string): boolean {
	switch (raw) {
		case "1":
		case "t":
		case "T":
		case "true":
		case "TRUE":
		case "True":
			return true;
		case "0":
		case "f":
		case "F":
		case "false":
		case "FALSE":
		case "False":
			return false;
		default:
			throw new FlagError(
				`invalid argument "${raw}" for "${flagLabel(spec)}" flag: ` +
					`strconv.ParseBool: parsing "${raw}": invalid syntax`,
			);
	}
}

/** How `pflag` names a flag in an error: `-h, --help`, or just `--help`. */
function flagLabel(spec: FlagSpec): string {
	return spec.shorthand === undefined
		? `--${spec.name}`
		: `-${spec.shorthand}, --${spec.name}`;
}

/** Applies one flag's value to the set being built. */
function assign(flags: CLIFlags, spec: FlagSpec, raw: string): void {
	const target = flags as unknown as Record<string, unknown>;
	target[spec.field] = spec.kind === "bool" ? parseBool(spec, raw) : raw;
}

/**
 * Parses `argv` -- everything after the program name.
 *
 * Throws a `FlagError` for anything `pflag` would reject, which the caller
 * reports before the usage text and exits 2 for.
 */
export function parseFlags(argv: readonly string[]): ParseResult {
	const flags = newFlags();
	const args: string[] = [];

	let i = 0;
	while (i < argv.length) {
		const token = argv[i] as string;
		i++;

		if (token === "--") {
			args.push(...argv.slice(i));
			break;
		}

		if (token.startsWith("--")) {
			const body = token.slice(2);
			const eq = body.indexOf("=");
			const name = eq < 0 ? body : body.slice(0, eq);

			const spec = BY_NAME.get(name);
			if (spec === undefined) {
				throw new FlagError(`unknown flag: --${name}`);
			}

			if (eq >= 0) {
				assign(flags, spec, body.slice(eq + 1));
				continue;
			}
			if (spec.kind === "bool") {
				assign(flags, spec, "true");
				continue;
			}
			if (i >= argv.length) {
				throw new FlagError(`flag needs an argument: --${name}`);
			}
			assign(flags, spec, argv[i] as string);
			i++;
			continue;
		}

		// A lone `-` is a positional argument, as it is for every Unix tool.
		if (token.startsWith("-") && token.length > 1) {
			let rest = token.slice(1);

			while (rest.length > 0) {
				const letter = rest[0] as string;
				rest = rest.slice(1);

				const spec = BY_SHORTHAND.get(letter);
				if (spec === undefined) {
					throw new FlagError(
						`unknown shorthand flag: '${letter}' in -${token.slice(1)}`,
					);
				}

				if (spec.kind === "bool") {
					if (rest.startsWith("=")) {
						assign(flags, spec, rest.slice(1));
						rest = "";
					} else {
						assign(flags, spec, "true");
					}
					continue;
				}

				if (rest.startsWith("=")) {
					assign(flags, spec, rest.slice(1));
				} else if (rest.length > 0) {
					assign(flags, spec, rest);
				} else if (i < argv.length) {
					assign(flags, spec, argv[i] as string);
					i++;
				} else {
					throw new FlagError(`flag needs an argument: --${spec.name}`);
				}
				rest = "";
			}
			continue;
		}

		args.push(token);
	}

	return { flags, args };
}
