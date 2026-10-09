#!/usr/bin/env bun
/**
 * A differential test of the pattern translator against Go's engine.
 *
 * The compatibility suite answers whether the whole port agrees with Vale. This
 * answers the narrower question underneath it: given the same pattern and the
 * same text, does `@vale-ts/regex` match where `regexp2` matches? That is worth
 * isolating, because a difference there is invisible until some rule in some
 * style quietly stops firing.
 *
 * The method is to make Vale answer for its own engine. Each pattern becomes a
 * one-token `existence` rule in a generated style, the real binary lints a
 * plain-text corpus with all of them, and its `file:line:column:rule:match`
 * output is compared against this port's regular expressions run over the same
 * text. Plain text is deliberate: there is no conversion between the file and
 * the block, so a column is a column and any difference is the engine's.
 *
 * ```
 * bun tests/compat/regex-diff.ts                 # the bundled patterns
 * bun tests/compat/regex-diff.ts --styles DIR    # every pattern under DIR
 * bun tests/compat/regex-diff.ts --limit 200
 * ```
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { strLen } from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";
import { parse as parseYAML } from "yaml";
import { fetchReference, REFERENCE, TESTDATA } from "./fetch.ts";

/**
 * The text every pattern is matched against.
 *
 * Chosen to exercise what the dialects disagree about: accented letters beside
 * ASCII words (the Unicode word boundary), a vertical tab and a non-breaking
 * space (RE2's narrower `\s`), digits that are and are not years, hyphenated
 * and underscored compounds, and the ordinary prose the rules were written for.
 */
const CORPUS = [
	"We utilize the thing in order to leverage it, and then we will utilize it again.",
	"The data is simply very unique; there are a number of reasons for this.",
	"Node.js 1.0 and gRPC and OAuth2 and e.g. i.e. etc. are all here.",
	"A naive cafe, a naïve café, and a façade -- with an em dash, a semi-colon; and more.",
	"Please don't use don’t or “smart quotes” or 'straight' ones carelessly.",
	"In 1999 and in 2024, 42 things and 100% of them were click here to read more.",
	"snake_case, kebab-case, CamelCase, SCREAMING_CASE and well-known compounds.",
	"Vertical\u000btab and non breaking space and tab\tseparated words.",
	"He said that that was the the problem, and and it is is repeated.",
	"The quick brown fox jumps over the lazy dog on Monday, January 1st.",
	"Whitelist the master branch, then sanity check the dummy value.",
	"It's a no-brainer: simply click the button, and the system will auto-magically work.",
].join("\n");

interface Hit {
	line: number;
	column: number;
	rule: string;
	match: string;
}

interface PatternSpec {
	/** The rule name the generated style gives it. */
	name: string;
	pattern: string;
	/** Whether the rule is `nonword`, which changes the template around it. */
	nonword: boolean;
	ignorecase: boolean;
	/** Where the pattern came from, for the report. */
	from: string;
}

export async function main(argv: readonly string[]): Promise<number> {
	const opts = parseOptions(argv);
	await fetchReference();

	const specs = collect(opts.styles, opts.limit);
	if (specs.length === 0) {
		console.error("no patterns found");
		return 2;
	}

	const dir = mkdtempSync(path.join(tmpdir(), "vale-regex-diff-"));
	try {
		build(dir, specs);

		const theirs = runReference(dir);
		const ours = runPort(specs);

		return report(specs, theirs, ours, opts.verbose) ? 0 : 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- gathering the patterns -----------------------------------------------

/**
 * The patterns to test: every `tokens` entry of every `existence` rule under
 * `styles`, plus a hand-written set covering the constructs the dialects
 * disagree about.
 */
function collect(styles: string, limit: number): PatternSpec[] {
	const specs: PatternSpec[] = [...HAND_WRITTEN];

	if (existsSync(styles)) {
		for (const file of yamlFiles(styles)) {
			let doc: Record<string, unknown>;
			try {
				doc = parseYAML(readFileSync(file, "utf8")) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (doc === null || typeof doc !== "object") continue;
			if (doc.extends !== "existence") continue;

			const tokens = doc.tokens;
			if (!Array.isArray(tokens)) continue;

			for (const token of tokens) {
				if (typeof token !== "string" || token.trim() === "") continue;
				specs.push({
					name: `P${specs.length}`,
					pattern: token,
					nonword: doc.nonword === true,
					ignorecase: doc.ignorecase === true,
					from: path.relative(styles, file),
				});
				if (specs.length >= limit) return specs;
			}
		}
	}

	return specs;
}

/** The cases a corpus of real rules does not reliably cover. */
const HAND_WRITTEN: PatternSpec[] = (
	[
		["cafe", false, false],
		["naive", false, false],
		["utilize", false, true],
		["Node\\.js", false, false],
		["don't", false, false],
		["that that", false, false],
		["is\\s+is", false, false],
		["\\d{4}", false, false],
		["\\d+%", true, false],
		["[A-Z][a-z]+_[a-z]+", false, false],
		["well-known", false, false],
		["\\w+\\s+case", false, true],
		["(?:simply|very)", false, true],
		["click\\s+here", false, true],
		["\\bauto-\\w+", true, false],
		["a\\s+number\\s+of", false, true],
		["(?i)MASTER", false, false],
		["(?-i)Whitelist", false, true],
		["\\s{2,}", true, false],
		["[^\\s]+ly\\b", true, false],
		["(?<=the )\\w+", true, false],
		["\\w+(?= dog)", true, false],
		["\\p{L}+é", true, false],
		["[[:alpha:]]{4,}ing", false, false],
		["(?:e\\.g\\.|i\\.e\\.)", true, false],
		["\\bthe\\b.{0,10}\\bthe\\b", true, false],
	] as Array<[string, boolean, boolean]>
).map(([pattern, nonword, ignorecase], i) => ({
	name: `H${i}`,
	pattern,
	nonword,
	ignorecase,
	from: "(hand-written)",
}));

function yamlFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (at: string): void => {
		for (const name of readdirSync(at)) {
			const full = path.join(at, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (name.endsWith(".yml") || name.endsWith(".yaml")) out.push(full);
		}
	};
	walk(dir);
	return out;
}

// --- the reference answer -------------------------------------------------

/** Writes a project where each pattern is a rule of its own. */
function build(dir: string, specs: readonly PatternSpec[]): void {
	mkdirSync(path.join(dir, "styles", "T"), { recursive: true });

	writeFileSync(
		path.join(dir, ".vale.ini"),
		[
			"StylesPath = styles",
			"MinAlertLevel = suggestion",
			"",
			"[*.txt]",
			"BasedOnStyles = T",
			"",
		].join("\n"),
	);
	writeFileSync(path.join(dir, "corpus.txt"), `${CORPUS}\n`);

	for (const spec of specs) {
		writeFileSync(
			path.join(dir, "styles", "T", `${spec.name}.yml`),
			[
				"extends: existence",
				'message: "%s"',
				"level: error",
				`nonword: ${spec.nonword}`,
				`ignorecase: ${spec.ignorecase}`,
				"tokens:",
				`  - ${JSON.stringify(spec.pattern)}`,
				"",
			].join("\n"),
		);
	}
}

/** What the real binary reports, by rule. */
function runReference(dir: string): Map<string, Hit[]> {
	const result = spawnSync(
		REFERENCE,
		["--output=line", "--sort", "--no-global", "--no-exit", "corpus.txt"],
		{ cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);

	const out = new Map<string, Hit[]>();
	for (const raw of `${result.stdout ?? ""}`.split("\n")) {
		// `corpus.txt:3:1:T.P12:match text`
		const m = /^[^:]+:(\d+):(\d+):T\.([^:]+):(.*)$/.exec(raw);
		if (m === null) continue;
		const hit: Hit = {
			line: Number(m[1]),
			column: Number(m[2]),
			rule: m[3]!,
			match: m[4]!,
		};
		const list = out.get(hit.rule);
		if (list === undefined) out.set(hit.rule, [hit]);
		else list.push(hit);
	}

	const stderr = `${result.stderr ?? ""}`.trim();
	if (stderr !== "" && out.size === 0) {
		throw new Error(`the reference binary reported: ${stderr}`);
	}

	return out;
}

// --- this port's answer ---------------------------------------------------

/**
 * The templates `makeRegexp` wraps a rule's tokens in.
 *
 * Reproduced here rather than imported, so that this test exercises the
 * translator against Vale's pattern shape even if the check package changes
 * how it builds one.
 */
const WORD_TEMPLATE = "(?m)\\b(?:%s)\\b";
const NONWORD_TEMPLATE = "(?m)(?:%s)";

function runPort(specs: readonly PatternSpec[]): Map<string, Hit[]> {
	const out = new Map<string, Hit[]>();

	for (const spec of specs) {
		const template = spec.nonword ? NONWORD_TEMPLATE : WORD_TEMPLATE;
		let source = template.replace("%s", spec.pattern);
		if (spec.ignorecase) source = `(?i)${source}`;

		let re: Regexp;
		try {
			re = Regexp.compile(source);
		} catch (err) {
			out.set(spec.name, []);
			console.error(
				`  ${spec.name}: ${spec.pattern}: ${err instanceof Error ? err.message : String(err)}`,
			);
			continue;
		}

		const hits: Hit[] = [];
		for (const [begin, end] of re.findAllStringIndex(CORPUS, -1)) {
			const text = CORPUS.slice(begin, end).trim();
			if (text === "") continue;
			// The alert's position is where the trimmed match starts.
			const at = begin + CORPUS.slice(begin, end).indexOf(text);
			hits.push({ ...positionOf(at), rule: spec.name, match: text });
		}
		out.set(spec.name, hits);
	}

	return out;
}

/** The 1-based line and column of an offset into the corpus. */
function positionOf(at: number): { line: number; column: number } {
	const before = CORPUS.slice(0, at);
	const nl = before.lastIndexOf("\n");
	return {
		line: before.split("\n").length,
		column: strLen(before.slice(nl + 1)) + 1,
	};
}

// --- comparing ------------------------------------------------------------

/**
 * Compares the two, reporting whether they agree.
 *
 * Only the *first* hit per line is compared. Vale reports one alert per
 * position per rule and masks what it has reported, so a rule matching the same
 * word twice on one line produces one alert there; counting all of them would
 * report a difference that is in the linter rather than in the engine.
 */
function report(
	specs: readonly PatternSpec[],
	theirs: Map<string, Hit[]>,
	ours: Map<string, Hit[]>,
	verbose: boolean,
): boolean {
	let agreed = 0;
	const differed: string[] = [];

	for (const spec of specs) {
		const a = firstPerLine(theirs.get(spec.name) ?? []);
		const b = firstPerLine(ours.get(spec.name) ?? []);

		if (same(a, b)) {
			agreed++;
			if (verbose) {
				console.log(`  agree  ${spec.name}  ${spec.pattern}  (${a.length} hits)`);
			}
			continue;
		}

		differed.push(
			[
				`  DIFFER ${spec.name}  ${spec.pattern}   [${spec.from}]`,
				`         regexp2:  ${a.join(" | ") || "(nothing)"}`,
				`         this port: ${b.join(" | ") || "(nothing)"}`,
			].join("\n"),
		);
	}

	for (const line of differed) console.log(line);

	console.log("");
	console.log(
		`${agreed}/${specs.length} patterns match identically` +
			` (${((agreed / specs.length) * 100).toFixed(1)}%)`,
	);

	return differed.length === 0;
}

/** One hit per line, as `line:column:match`, sorted. */
function firstPerLine(hits: readonly Hit[]): string[] {
	const byLine = new Map<number, Hit>();
	for (const h of hits) {
		const seen = byLine.get(h.line);
		if (seen === undefined || h.column < seen.column) byLine.set(h.line, h);
	}
	return [...byLine.values()]
		.sort((x, y) => x.line - y.line)
		.map((h) => `${h.line}:${h.column}:${h.match}`);
}

function same(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

interface Options {
	styles: string;
	limit: number;
	verbose: boolean;
}

function parseOptions(argv: readonly string[]): Options {
	const opts: Options = {
		styles: path.join(TESTDATA, "styles"),
		limit: 400,
		verbose: argv.includes("--verbose") || argv.includes("-v"),
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--styles") opts.styles = argv[i + 1] ?? opts.styles;
		else if (argv[i] === "--limit") opts.limit = Number(argv[i + 1] ?? opts.limit);
	}
	return opts;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
