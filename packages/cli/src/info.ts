/**
 * The help screens.
 *
 * Every one of them opens with the same intro, which is built when it is
 * printed rather than when the module loads: it carries styling, and whether
 * styling is wanted depends on where the output is going -- a question answered
 * after the flags are parsed.
 */

import type { Command } from "./command.ts";
import { COMMANDS, visibleCommandNames } from "./command.ts";
import { FLAGS, SHORTCODES } from "./flags.ts";
import type { Writer } from "./out.ts";
import { println } from "./out.ts";
import { bold, code, renderBorderless, underline } from "./term.ts";

const EXAMPLE_CONFIG = `MinAlertLevel = suggestion

	[*]
	BasedOnStyles = Vale`;

/** The header every help screen opens with. */
function intro(): string {
	return `vale - A command-line linter for prose.

${bold("Usage")}:\t${code("vale [options] [input...]")}
\t${code("vale myfile.md myfile1.md mydir1")}
\t${code("vale --output=JSON [input...]")}

Vale is a syntax-aware linter for prose built with speed and extensibility in
mind. It supports Markdown, AsciiDoc, reStructuredText, HTML, and more.

To get started, you'll need a configuration file (${code(".vale.ini")}):

${bold("Example")}:

\t${code(EXAMPLE_CONFIG)}

See ${underline("https://vale.sh")} for more setup information.`;
}

/**
 * The flags the listing leaves out: compatibility shims, the switches the test
 * suite and editor integrations set, and flags that work but are not announced
 * yet.
 */
const HIDDEN_FLAGS: readonly string[] = [
	"apply", // Not announced yet: `fix --apply` is still settling.
	"built",
	"counts", // Not announced yet: the summary shape is still settling.
	"mode-compat",
	"mode-rev-compat",
	"normalize",
	"relative",
	"sort",
	"sources",
];

/**
 * The flags that lead the listing, ahead of the ones that shape output for a
 * script rather than for a person.
 */
const COMMON_FLAGS: readonly string[] = [
	"config",
	"output",
	"minAlertLevel",
	"glob",
	"filter",
	"help",
	"version",
];

/** The intro plus a pointer at the full listing. */
function infoText(): string {
	return `${intro()}

(Or use ${code("vale --help")} for a listing of all CLI options.)`;
}

/** Shows basic usage and getting-started information. */
export function printIntro(): void {
	println(infoText());
}

/** A flag as the listing names it, with its short form when it has one. */
function toFlag(name: string): string {
	const short = SHORTCODES[name];
	if (short !== undefined) return `${code(`-${short}`)}, ${code(`--${name}`)}`;
	return code(`--${name}`);
}

/**
 * Writes the full listing of flags and commands.
 *
 * The destination is the caller's to choose, and it is the difference between
 * the two reasons this gets printed: help that was asked for is output, and
 * belongs on stdout, while help that follows a mistake is a diagnostic and
 * belongs on stderr. Nor does this exit -- the first case is a success and the
 * second is not.
 */
export function printUsage(write: Writer): void {
	write(`${intro()}\n`);

	// Common first. Alphabetical order put `--ext` and `--filter` ahead of
	// `--output`, which is the flag most runs actually pass.
	const common: string[][] = [];
	const rest: string[][] = [];

	for (const spec of [...FLAGS].sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (HIDDEN_FLAGS.includes(spec.name)) continue;
		const row = [toFlag(spec.name), spec.usage];
		if (COMMON_FLAGS.includes(spec.name)) common.push(row);
		else rest.push(row);
	}

	common.sort(
		(a, b) =>
			COMMON_FLAGS.indexOf(flagName(a[0] as string)) -
			COMMON_FLAGS.indexOf(flagName(b[0] as string)),
	);

	section(write, "Flags:", common);
	section(write, "More flags:", rest);

	const listing = visibleCommandNames().map((name) => [
		code(name),
		COMMANDS[name]?.summary ?? "",
	]);
	section(write, "Commands:", listing);

	write(`Run ${code("vale <command> --help")} for a command's own help.\n\n`);
}

/** Writes one command's help. */
export function printCommandUsage(write: Writer, name: string, cmd: Command): void {
	write(`vale ${name} - ${cmd.summary}\n\n`);

	const usage = cmd.usage === undefined || cmd.usage === "" ? name : cmd.usage;
	write(`${bold("Usage")}:\t${code(`vale ${usage}`)}\n`);

	if (cmd.detail !== undefined && cmd.detail !== "") {
		write(`\n${cmd.detail}\n`);
	}

	write(`\nSee ${underline("https://vale.sh")} for more.\n`);
}

/** Renders one titled block of the listing, or nothing when it is empty. */
function section(write: Writer, title: string, rows: string[][]): void {
	if (rows.length === 0) return;

	write(`${bold(`\n${title}`)}\n`);
	write("\n");
	write(renderBorderless(rows));
	write("\n");
}

/**
 * Recovers a flag's name from a rendered cell, which may carry a shortcode and
 * styling.
 */
function flagName(cell: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequence is what is stripped.
	const plain = cell.replace(/\u001b\[[0-9;]*m/g, "");
	const at = plain.indexOf("--");
	return at < 0 ? plain : plain.slice(at + 2);
}
