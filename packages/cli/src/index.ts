/**
 * `@vale-ts/cli` -- the `vale` command line.
 *
 * `run(argv)` is the whole program as a function: it parses the flags, runs
 * whichever command or lint the arguments describe, and returns the exit code
 * rather than taking the process down. That is what lets the compatibility
 * suite check a case in-process, and what `main.ts` wraps with the one
 * `process.exit` in the package.
 *
 * ```ts
 * import { run } from "@vale-ts/cli";
 *
 * const code = await run(["--output=JSON", "README.md"]);
 * ```
 */

export type { Meta, Release, Style } from "./api.ts";
export { fetchArchive } from "./api.ts";
export type { FixEdit, FixedFile, FixSkip } from "./apply.ts";
export {
	applyFixes,
	fixFile,
	lineOffsets,
	resolveEdits,
	spanOf,
	widenRemoval,
} from "./apply.ts";
export { printVerboseAlerts } from "./color.ts";
export type { Command } from "./command.ts";
export { COMMANDS, visibleCommandNames } from "./command.ts";
export { printAlerts } from "./common.ts";
export { configJSON } from "./config-json.ts";
export { printCustomAlerts } from "./custom.ts";
export { asValeError, banner, showError } from "./error.ts";
export type { FlagKind, FlagSpec, ParseResult } from "./flags.ts";
export { FLAGS, FlagError, parseFlags, SHORTCODES } from "./flags.ts";
export { FUNCS } from "./funcs.ts";
export { printCommandUsage, printIntro, printUsage } from "./info.ts";
export {
	alertJSON,
	countAlerts,
	printJSONAlerts,
	printJSONAlertsWithCounts,
} from "./json.ts";
export { printLineAlerts } from "./line.ts";
export { run } from "./main.ts";
export type { Writer } from "./out.ts";
export { capture, errorln, println, stderr, stdout } from "./out.ts";
export {
	pkgMeta,
	releaseTags,
	sortedReleases,
	supportedRelease,
	supportsVale,
} from "./pkgver.ts";
export type { Constraint, Version } from "./semver.ts";
export {
	compareVersions,
	parseConstraint,
	parseVersion,
	satisfies,
} from "./semver.ts";
export { didYouMean, levenshtein, reportUnknownCommand } from "./suggest.ts";
export {
	download,
	initPath,
	installPackages,
	installPkg,
	pkgRoot,
	readPkg,
	syncCommand,
} from "./sync.ts";
export type { Emit, TemplateFunc } from "./template.ts";
export {
	parseTemplate,
	sprintf,
	stringify,
	Template,
	truthy,
} from "./template.ts";
export type { Progress } from "./term.ts";
export {
	renderBorderless,
	renderTable,
} from "./term.ts";
export { runTests, TestFailed } from "./test.ts";
export { isRule, ruleNames, uncovered } from "./testsuite/coverage.ts";
export type { Line } from "./testsuite/diff.ts";
export { Add, Del, diff, Same } from "./testsuite/diff.ts";
export type { Result } from "./testsuite/run.ts";
export { compare, failed, isolatedName, Runner } from "./testsuite/run.ts";
export type { Case } from "./testsuite/suite.ts";
export { caseExt, findCases, loadCases } from "./testsuite/suite.ts";
export {
	colorOn,
	configureColor,
	detectTerminal,
	isTTY,
	setTerminal,
} from "./tty.ts";
export {
	destinationFor,
	MAX_UNARCHIVED_FILE,
	unarchive,
} from "./unarchive.ts";
export { asMap, getJSON, goJSON, pluralize, printJSON } from "./util.ts";
export { setVersion, version } from "./version.ts";
