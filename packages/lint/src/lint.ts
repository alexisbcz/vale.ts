/**
 * The linter: what decides which rules run, over which blocks, in which order.
 *
 * A document is read into blocks by one of the format readers, each block is
 * handed to every rule whose scope matches it, and each alert those rules
 * produce is placed in the file. The ordering is deliberate and load-bearing:
 * alerts are added in rule order, so which rule wins a span -- and what the
 * masked context holds when a later one is formatted -- does not depend on
 * anything but the rules themselves.
 *
 * # Synchronous
 *
 * Go lints files concurrently and, within a large block, runs the rules that
 * read nothing but their block concurrently too. This port is synchronous.
 * Nothing about the result depends on that in Go either -- the comments there
 * are explicit that the scheduler must not be able to change an answer -- so
 * the two agree, and a caller that wants parallelism can lint several files in
 * separate workers.
 */

import * as path from "node:path";
import type {
	Definition,
	Manager,
	Rule,
	ScopeMatcher,
	Selection,
} from "@vale-ts/check";
import { newScope } from "@vale-ts/check";
import type {
	Alert,
	Block,
	CLIFlags,
	Config,
	File,
	NLPInfo,
	ScopedValues,
} from "@vale-ts/core";
import {
	Block as CoreBlock,
	computeBlocks,
	formatAlert,
	Glob,
	LEVEL_TO_INT,
	newE100,
	newFile,
	normalizePathFormat,
	shouldIgnoreDirectory,
	styleName,
	toSlash,
	ValeError,
	walk,
} from "@vale-ts/core";
import { quoteSpans, segmentText } from "@vale-ts/nlp";
import { lintHTMLTokens, type ReaderHost } from "./ast.ts";
import { lintHTML, textToHTML } from "./html.ts";
import { lintMarkdown, type MarkdownHost } from "./md.ts";
import { lintMetadata, type MetadataHost } from "./metadata.ts";
import { applyPatterns, type ExtensionConfig } from "./patterns.ts";
import { lintScopedValues, type ScopedHost } from "./scoped.ts";
import { markSelections } from "./selection.ts";

/** A rule together with the name it was registered under. */
interface ScopedRule {
	name: string;
	rule: Rule;
}

/** The documents a run could not lint, each with its own error. */
export class DocumentErrors extends Error {
	readonly errors: Error[];

	constructor(errors: Error[]) {
		super(errors.map((e) => e.message).join("\n"));
		this.name = "DocumentErrors";
		this.errors = errors;
	}
}

/** The result of linting one document. */
export interface LintResult {
	file: File | null;
	err: Error | null;
	/** The document linted, for an error that is about it. */
	path: string;
}

/**
 * Whether `err` is about the document at `path` -- one Vale could not read or
 * parse -- rather than about the configuration or a rule.
 */
function documentError(err: Error, p: string): boolean {
	if (p === "" || !(err instanceof ValeError)) return false;
	for (const candidate of [err.path, err.context]) {
		if (candidate !== "" && path.normalize(candidate) === path.normalize(p)) {
			return true;
		}
	}
	return false;
}

/** The document an error from `documentError` is about. */
function errorPath(err: Error): string {
	if (err instanceof ValeError) {
		return err.path !== "" ? err.path : err.context;
	}
	return "";
}

export class Linter implements ReaderHost, MarkdownHost, MetadataHost, ScopedHost {
	readonly manager: Manager;

	/** Receives every block before its rules run, when set. */
	blockHook: ((blk: Block) => void) | null = null;
	/** Receives each rule's name and what its run cost, when set. */
	ruleHook: ((name: string, tookMs: number) => void) | null = null;

	private glob: Glob | null = null;
	private readonly nonGlobal: boolean;

	/**
	 * The rules whose scope matches a given block scope, keyed by the block's
	 * scope and parent.
	 *
	 * Whether a rule's scope matches depends on nothing else, and a document has
	 * a handful of distinct block scopes against several hundred rules -- so the
	 * answer was being recomputed for every rule on every block, which was the
	 * largest part of deciding what to run.
	 */
	private readonly inScope = new Map<string, ScopedRule[]>();

	/** The readers for the formats this linter knows, by normed extension. */
	private readonly readers = new Map<string, (f: File) => void>();

	/** `IgnoredScopes` as a matcher, built once. */
	private ignored: ScopeMatcher | null = null;

	/**
	 * Whether a `dasel` or `textfsm` view reads this file.
	 *
	 * Set by the data reader when it registers itself. Either engine reads the
	 * whole file for itself, so the file's own format does not matter; a
	 * tree-sitter view is reached through the code reader instead.
	 */
	hasView: ((f: File) => boolean) | null = null;

	/** Whether a tree-sitter view reads this file. */
	hasCodeView: ((f: File) => boolean) | null = null;

	/** Whether this file is a Vale rule, which has prose in two of its fields. */
	isRuleFile: ((f: File) => boolean) | null = null;

	constructor(manager: Manager) {
		this.manager = manager;
		const cfg = manager.config;
		this.nonGlobal = cfg.gBaseStyles.length + Object.keys(cfg.gChecks).length === 0;
	}

	get config(): Config {
		return this.manager.config;
	}

	get flags(): CLIFlags {
		return this.manager.config.flags;
	}

	/**
	 * Registers a reader for a markup format.
	 *
	 * The readers live in their own modules and are plugged in here, so that a
	 * caller that lints only Markdown never loads the AsciiDoc one -- and so a
	 * new format is a new file rather than a change to this one.
	 */
	register(normedExt: string, reader: (f: File) => void): void {
		this.readers.set(normedExt, reader);
	}

	/** Whether a reader is registered for `normedExt`. */
	has(normedExt: string): boolean {
		return this.readers.has(normedExt);
	}

	// --- the reader host ----------------------------------------------------

	hasScope(scope: string): boolean {
		return this.manager.hasScope(scope);
	}

	selections(): Selection[] {
		return this.manager.selections();
	}

	markSelections(
		raw: string,
		sels: ReadonlyArray<{ id: string; sel: string }>,
		quotes: boolean,
	): string {
		return markSelections(raw, sels, quotes);
	}

	/**
	 * Applies the rewrites the configuration asks for before a document is
	 * read: block and token ignores, custom comment delimiters, and the
	 * front-matter wrap.
	 */
	transform(f: File): string {
		const exts: ExtensionConfig = {
			normed: f.normedExt,
			real: f.realExt,
			realPath: f.path,
			held: f.held,
		};
		return applyPatterns(this.config, exts, f.content);
	}

	/** Reads a document's HTML and lints every block in it. */
	lintHTMLTokens(f: File, raw: string, offset: number): void {
		lintHTMLTokens(this, f, raw, offset);
	}

	/** The scopes `IgnoredScopes` excludes. */
	ignoredScope(): ScopeMatcher {
		this.ignored ??= newScope(this.config.ignoredScopes);
		return this.ignored;
	}

	/** Lints the prose fields of a document's front matter. */
	lintMetadata(f: File): void {
		lintMetadata(this, f);
	}

	/** Lints every value a view found, placing each one's alerts in the file. */
	lintScopedValues(f: File, values: readonly ScopedValues[]): void {
		lintScopedValues(this, f, values);
	}

	/**
	 * Reads the file as the named markup.
	 *
	 * A value a view found may be written in Markdown, reStructuredText or any
	 * other format Vale reads; this is how it reaches that format's reader.
	 */
	readAs(f: File, format: string): void {
		const reader = this.readers.get(`.${format}`);
		if (reader === undefined) {
			throw newE100(f.path, new Error(`unsupported markup format '${format}'`));
		}
		reader(f);
	}

	/** Reads the file's text as code, so that its comments are the prose. */
	readAsCode(f: File, ext: string): void {
		const code = this.readers.get("code");
		if (code === undefined) {
			this.lintLines(f);
			return;
		}
		const realExt = f.realExt;
		const normedExt = f.normedExt;
		f.realExt = ext;
		f.normedExt = ext;
		try {
			code(f);
		} finally {
			f.realExt = realExt;
			f.normedExt = normedExt;
		}
	}

	// --- entry points -------------------------------------------------------

	/** Lints a string, as `cat page.md | vale` does. */
	lintString(src: string): File[] {
		const result = this.lintOne(src);
		if (result.err !== null) throw result.err;
		return result.file === null ? [] : [result.file];
	}

	/**
	 * Lints every file under `input` that `pat` matches.
	 *
	 * A document that cannot be read or parsed is reported and the rest are
	 * still linted; anything else stops the run.
	 */
	lint(input: readonly string[], pat: string): File[] {
		const linted: File[] = [];

		try {
			this.glob = Glob.compile(pat);
		} catch (err) {
			throw newE100("--glob", err);
		}

		const docErrs: Error[] = [];
		for (const src of input) {
			for (const result of this.collect(src)) {
				if (result.err !== null && documentError(result.err, result.path)) {
					docErrs.push(result.err);
					continue;
				}
				if (result.err !== null) throw result.err;
				if (result.file === null) continue;
				if (this.flags.normalize) result.file.path = toSlash(result.file.path);
				linted.push(result.file);
			}
		}

		if (docErrs.length > 0) {
			docErrs.sort((a, b) => errorPath(a).localeCompare(errorPath(b)));
			throw new DocumentErrors(docErrs);
		}
		return linted;
	}

	/** Walks `root` and lints every file that should be linted. */
	private collect(root: string): LintResult[] {
		const out: LintResult[] = [];
		walk(root, (entry) => {
			if (entry.isDirectory) {
				// A `StylesPath` holds rules, vocabularies and synced packages,
				// not prose; it is linted only when named.
				if (
					shouldIgnoreDirectory(entry.path) ||
					(entry.path !== root && this.isStylesPath(entry.path))
				) {
					return false;
				}
				return true;
			}
			if (this.skip(entry.path)) return true;
			out.push(this.lintOne(entry.path));
			return true;
		});
		return out;
	}

	/**
	 * Lints one document, choosing a reader by its format.
	 *
	 * `src` is a path when the file exists and the text itself otherwise.
	 */
	lintOne(src: string): LintResult {
		let file: File;
		try {
			file = newFile(src, this.config);
		} catch (err) {
			return { file: null, err: asError(err), path: src };
		}

		if (this.runsNothing(file)) {
			// No rule can run here -- `BasedOnStyles =` in a section that
			// matched, say -- so the file is not parsed at all.
			return { file, err: null, path: src };
		}

		// What language work this file needs; the goal is to do the least
		// possible. The manager answers for the whole run, so a file is only
		// segmented when a rule asking for it runs there.
		const nlp: NLPInfo = this.manager.assignNLP(file);
		nlp.segmentation = nlp.segmentation && this.runsScoped(file, "sentence");
		nlp.splitting = nlp.splitting && this.runsScoped(file, "paragraph");
		file.nlp = nlp;

		let err: Error | null = null;
		try {
			this.read(file);
		} catch (caught) {
			err = asError(caught);
		}

		// A comment read after a block was linted still covers that block: a
		// converter may emit a promoted title ahead of the comment above it.
		file.dropDisabled();

		if (err === null) {
			try {
				// Every rule with `scope: raw`.
				//
				// The file's lines rather than its content, so that no markup
				// preprocessing is included.
				const raw = new CoreBlock("", file.lines.join(""), `raw${file.realExt}`);
				this.lintBlock(file, raw, file.lines.length, 0, true);
			} catch (caught) {
				err = asError(caught);
			}
		}

		// A transformed file's alerts live in the stylesheet's output, which the
		// sanitizer's shifts say nothing about.
		if (err === null && file.transform === "") file.mapAlertsToSource();

		return { file, err, path: src };
	}

	/**
	 * Dispatches to the reader for this file.
	 *
	 * The order is the order Go tests the cases in, and it is load-bearing. A
	 * view comes first, because a view says what a file's prose is whatever the
	 * file is called -- without that, a `.jsonl` or a `.log` that a section
	 * matched was linted whole and the view never ran. A Vale rule comes before
	 * the data readers, because its message and description are prose while its
	 * tokens and swaps are patterns, often wrong on purpose. And a data file
	 * that a tree-sitter view names is read as code, so the view's queries
	 * reach its comments.
	 *
	 * `--simple` turns all of it off: the file is read as lines, which is what
	 * the flag is for.
	 */
	private read(file: File): void {
		const simple = this.flags.simple;

		if (!simple && this.hasView?.(file) === true) {
			this.readers.get("data")?.(file);
			return;
		}

		const reader = this.readers.get(file.normedExt);
		if (!simple && file.format === "markup" && reader !== undefined) {
			reader(file);
			return;
		}

		if (!simple && this.isRuleFile?.(file) === true) {
			const rule = this.readers.get("rule");
			if (rule !== undefined) {
				rule(file);
				return;
			}
		}

		if (
			!simple &&
			file.format === "data" &&
			this.hasCodeView?.(file) === true
		) {
			const code = this.readers.get("code");
			if (code !== undefined) {
				code(file);
				return;
			}
		}

		if (
			!simple &&
			file.format === "data" &&
			Object.keys(this.config.views).length > 0
		) {
			const data = this.readers.get("data");
			if (data !== undefined) {
				data(file);
				return;
			}
		}

		if (!simple && file.format === "code") {
			const code = this.readers.get("code");
			if (code !== undefined) {
				code(file);
				return;
			}
		}

		if (!simple && file.format === "fragment") {
			const fragments = this.readers.get("fragment");
			if (fragments !== undefined) {
				fragments(file);
				return;
			}
		}

		if (!simple && file.normedExt === ".txt") {
			this.lintTxt(file);
			return;
		}

		this.lintLines(file);
	}

	// --- block plumbing -----------------------------------------------------

	/**
	 * Segments a block and runs every applicable rule over the results.
	 *
	 * `split` says whether the block holds paragraphs; a heading or a list item
	 * is prose, but not a paragraph.
	 */
	lintProse(f: File, blk: Block, lines: number, split: boolean): void {
		const blocks = computeBlocks(f.nlp, blk, split, segmentText);

		// Paragraphs that lack a blank line between them cannot be placed by
		// position alone, so their alerts are located by searching.
		const needsLookup = blk.text.includes("\n") || f.lookup;

		for (const b of blocks) {
			this.lintBlock(f, b, lines, 0, needsLookup);
		}
	}

	/** Runs every applicable rule over `blk`. */
	lintBlock(
		f: File,
		blk: Block,
		lines: number,
		pad: number,
		lookup: boolean,
	): void {
		f.startBlock();
		this.blockHook?.(blk);

		for (const { name, rule } of this.inScopeFor(blk)) {
			if (!this.shouldRun(name, f, rule)) continue;

			const info = rule.fields();
			const start = this.ruleHook === null ? 0 : performance.now();
			const alerts = rule.run(blockFor(blk, rule), f, this.config);
			this.ruleHook?.(name, performance.now() - start);

			for (const alert of alerts) {
				if (f.queryComments(`${name}[${alert.match}]`)) continue;
				setLevel(alert, f, info, name);
				f.addAlert(alert, blk, lines, pad, lookup);
			}
		}
	}

	/** Lints plain text, which is its own document rather than markup. */
	lintTxt(f: File): void {
		// A manuscript with chapters is a document: its chapter lines are
		// headings, and each one opens a section.
		const doc = textToHTML(f.content);
		if (doc.ok) {
			this.lintHTMLTokens(f, doc.html, 0);
			return;
		}

		const block = new CoreBlock("", f.content, `text${f.metaScope}${f.realExt}`);

		// Plain text never becomes HTML, so its quotations are paired here and
		// carried as inline runs, the way the walker carries a `q`.
		if (this.manager.hasScope("quote")) {
			for (const [begin, end] of quoteSpans(f.content)) {
				block.inline.push({ scope: "quote", begin, end });
			}
		}

		this.lintProse(f, block, f.lines.length, true);

		for (const inline of block.inline) {
			const text = f.content.slice(inline.begin, inline.end);
			const line = 1 + countNewlines(f.content.slice(0, inline.begin));
			const b = new CoreBlock(
				f.content,
				text,
				`quote${f.metaScope}${f.realExt}`,
				line,
			);
			b.offset = inline.begin;
			this.lintBlock(f, b, f.lines.length, 0, false);
		}

		// No reader writes a plain-text file's summary, so the file is its own:
		// one run covering it, and a paragraph per run of lines between blank
		// lines. Without this a `metric` rule never fired on `.txt`.
		f.summary += f.content;
		f.summaryRuns = [{ at: 0, src: 0, n: f.content.length }];
		f.metrics.paragraphs = countParagraphs(f.content);
		this.lintSizedScopes(f);
	}

	/** Lints a file as one undifferentiated block of lines. */
	lintLines(f: File): void {
		const block = new CoreBlock("", f.content, `text${f.metaScope}${f.realExt}`);
		this.lintBlock(f, block, f.lines.length, 0, true);
	}

	/** Runs the rules scoped to the whole document, if any asks for it. */
	lintSizedScopes(f: File): void {
		f.resetComments();

		// A fragment is one comment of a file, and its summary is the file's:
		// linted once, when every comment has been read. Doing it here
		// lower-cased the whole summary so far for every comment, which is
		// quadratic in the file.
		if (f.format === "fragment") return;
		this.lintSummary(f);
	}

	/** Runs the rules scoped to `summary` over what the file's blocks added up to. */
	lintSummary(f: File): void {
		if (!this.runsScoped(f, "summary")) return;

		const summary = new CoreBlock(f.content, f.summary, `summary${f.realExt}`, 0);
		summary.runs = f.summaryRuns;
		summary.metrics = f.metrics;

		this.lintBlock(f, summary, f.lines.length, 0, true);
	}

	// --- deciding what runs -------------------------------------------------

	/**
	 * Whether no rule can run for `f`: it bases on no style, and no rule is
	 * switched on by name, in a section or globally.
	 *
	 * Errs toward false; `shouldRun` has the final say on each rule.
	 */
	private runsNothing(f: File): boolean {
		if (f.baseStyles.length > 0) return false;
		for (const on of Object.values(f.checks)) {
			if (on) return false;
		}
		for (const [k, on] of Object.entries(this.config.gChecks)) {
			const set = k in f.checks;
			const v = f.checks[k];
			if (on && f.unset[k] !== true && (!set || v === true)) return false;
		}
		return true;
	}

	/** The rules that could run on `blk`, by scope alone. */
	private inScopeFor(blk: Block): ScopedRule[] {
		const key = `${blk.scope}\u0000${blk.parent}`;
		const hit = this.inScope.get(key);
		if (hit !== undefined) return hit;

		const found: ScopedRule[] = [];
		for (const [name, rule] of this.manager.rules()) {
			if (newScope(rule.fields().scope).matches(blk)) found.push({ name, rule });
		}

		// A stable order, so that two blocks of the same scope are linted in the
		// same sequence.
		found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

		this.inScope.set(key, found);
		return found;
	}

	/** Whether `dir` is one of the configuration's styles paths. */
	private isStylesPath(dir: string): boolean {
		const abs = path.resolve(dir);
		for (const p of this.config.paths) {
			if (path.resolve(p) === abs) return true;
		}
		return false;
	}

	/** Whether a rule scoped to `scope` will run on `f`. */
	private runsScoped(f: File, scope: string): boolean {
		const rules = this.manager.rules();
		for (const name of this.manager.rulesForScope(scope)) {
			// A `--filter` removes rules after they were registered.
			const rule = rules.get(name);
			if (rule !== undefined && this.shouldRun(name, f, rule)) return true;
		}
		return false;
	}

	/** Whether `rule` runs on `f`. */
	shouldRun(nameArg: string, f: File, rule: Rule): boolean {
		const minLevel = this.config.minAlertLevel;
		const details = rule.fields();

		// Configuration addresses the defining rule: a `consistency` alert's
		// name carries a matched term, and a rule's own name may span
		// subdirectories, so the rule is found by name, not by counting dots.
		const name = this.manager.ruleForAlert(nameArg);

		if (f.queryComments(name)) {
			// Disabled by an in-text comment.
			return false;
		}
		if ((LEVEL_TO_INT[f.level(name, details.level)] ?? 0) < minLevel) {
			// The level this file gives the rule, which a section may have
			// changed for this format alone.
			return false;
		}

		const style = styleName(name);
		let run = false;

		// Disabled for this extension? The rule's own setting is looked for
		// first and the style's only after, so that `proselint = NO` can turn a
		// style off while `proselint.Typography = YES` keeps one of its rules.
		const forFile = lookupSetting(f.checks, name, style);
		if (forFile !== undefined && !run) {
			if (!forFile) return false;
			run = true;
		}

		// Disabled for all extensions? A key the section marked `UNSET` takes no
		// global setting either.
		const global = lookupUnless(this.config.gChecks, f.unset, name, style);
		if (global !== undefined && !run) {
			if (!global) return false;
			run = true;
		}

		if (!run && !f.baseStyles.includes(style)) return false;
		return true;
	}

	private match(s: string): boolean {
		return this.glob === null ? true : this.glob.match(s);
	}

	/** Whether a file should be left alone. */
	private skip(old: string): boolean {
		const ref = toSlash(normalizePathFormat(old, this.config.formats));

		if (!this.match(old) && !this.match(ref)) return true;

		if (this.nonGlobal) {
			// With nothing turned on globally, a file no section matches has no
			// rules at all, so it is not worth reading.
			for (const pat of Object.values(this.config.secToPat)) {
				if (pat.match(old) || pat.match(ref)) return false;
			}
			return true;
		}

		return false;
	}
}

/**
 * Finishes an alert, reporting it at the level this file gives its rule.
 *
 * Assigning the severity rather than leaving it to `formatAlert` is what makes
 * a per-format level take effect: a check builds its alerts with the level it
 * was compiled with already set, and `formatAlert` only fills a severity that
 * is still empty.
 */
function setLevel(a: Alert, f: File, info: Definition, name: string): void {
	const level = f.level(name, info.level);
	formatAlert(a, info.limit, level, name);
	a.severity = level;
}

/**
 * `blk` as the rule sees it: with the text of any inline element the rule's
 * scope negates blanked out.
 */
function blockFor(blk: Block, rule: Rule): Block {
	if (blk.inline.length === 0) return blk;
	const excluded = newScope(rule.fields().scope).excluded;
	if (excluded.length === 0) return blk;
	return blk.without(excluded);
}

/** Reads a setting for a rule, falling back to one for the style it belongs to. */
function lookupSetting(
	settings: Record<string, boolean>,
	rule: string,
	style: string,
): boolean | undefined {
	if (rule in settings) return settings[rule];
	if (style in settings) return settings[style];
	return undefined;
}

/** `lookupSetting`, skipping a key a section marked unset. */
function lookupUnless(
	settings: Record<string, boolean>,
	unset: Record<string, boolean>,
	rule: string,
	style: string,
): boolean | undefined {
	if (rule in settings && unset[rule] !== true) return settings[rule];
	if (style in settings && unset[style] !== true) return settings[style];
	return undefined;
}

/** Counts the runs of non-blank lines in plain text. */
function countParagraphs(text: string): number {
	let n = 0;
	for (const p of text.split("\n\n")) {
		if (p.trim() !== "") n++;
	}
	return n;
}

function countNewlines(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\n") n++;
	}
	return n;
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
