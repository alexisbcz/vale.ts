/**
 * Vale's configuration: what `.vale.ini` says, and how several of them stack.
 *
 * A run reads more than one file. The user's global configuration is always
 * read, then the project's, then any a package shipped. Rather than merging
 * them as it goes, the loader stacks every value a key was given as a
 * *shadow*, and each option decides for itself which layer wins: a list key
 * like `BasedOnStyles` takes them all, a scalar like `MinAlertLevel` takes the
 * last, and `NONE` anywhere in a list clears whatever came before it.
 *
 * Sections are glob patterns, not names. `[*.md]` applies to every Markdown
 * file, `[docs/*.md]` only to those under `docs`, and `[*.md if .Meta.draft]`
 * only to the drafts among them. Several sections can apply to one file, and
 * they are applied in the order they were written, so a later one wins -- for
 * that file, and no other.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ALERT_LEVELS, LEVEL_TO_INT } from "./alert.ts";
import { Condition, splitSection } from "./condition.ts";
import {
	newE100,
	newE201FromKey,
	newE201FromTarget,
	ValeError,
	warn,
} from "./errors.ts";
import { Glob } from "./glob.ts";
import {
	DEFAULT_SECTION,
	emptyINI,
	type File as INIFile,
	type Key,
	loadInto,
	parseINI,
	type Section,
} from "./ini.ts";
import {
	absPath,
	determinePath,
	fileExists,
	isDir,
	path as nodePath,
	walk,
	xdg,
} from "./system.ts";
import { baseName, dirName, extName, toSlash } from "./util.ts";
import { newView, type View } from "./view.ts";
import {
	newVocabulary,
	parseVocabYAML,
	readWordList,
	VOCAB_FILES,
	type Vocabulary,
} from "./vocab.ts";

/**
 * Where Vale's own configuration files live, relative to the `StylesPath`.
 *
 * Standardized in v3 so that a package can ship a dictionary, a template or a
 * view and have it found without the project naming it.
 */
export const CONFIG_DIR = "config";

/** Where `sync` writes the configuration files a package shipped. */
export const PIPE_DIR = ".vale-config";

export const VOCAB_DIR = nodePath.join(CONFIG_DIR, "vocabularies");
export const DICT_DIR = nodePath.join(CONFIG_DIR, "dictionaries");
export const TMPL_DIR = nodePath.join(CONFIG_DIR, "templates");
export const IGNORE_DIR = nodePath.join(CONFIG_DIR, "ignore");
export const ACTION_DIR = nodePath.join(CONFIG_DIR, "actions");
export const FILTER_DIR = nodePath.join(CONFIG_DIR, "filters");
export const SCRIPT_DIR = nodePath.join(CONFIG_DIR, "scripts");
export const VIEW_DIR = nodePath.join(CONFIG_DIR, "views");
export const SCOPE_DIR = nodePath.join(CONFIG_DIR, "scopes");

/** Every directory holding user-defined, non-style configuration. */
export const CONFIG_DIRS = [
	VOCAB_DIR,
	DICT_DIR,
	TMPL_DIR,
	IGNORE_DIR,
	ACTION_DIR,
	SCRIPT_DIR,
	FILTER_DIR,
	VIEW_DIR,
	SCOPE_DIR,
];

/** The environment variables Vale reads, and what each is for. */
export const CONFIG_VARS: Record<string, string> = {
	VALE_CONFIG_PATH:
		"Override the default search process by specifying a .vale.ini file.",
	VALE_STYLES_PATH: "Specify the location of the default StylesPath.",
};

/**
 * Every name a configuration file may have.
 *
 * Left over from Vale's early days; `.vale.ini` is the one to document.
 */
const CONFIG_NAMES = [".vale", "_vale", "vale.ini", ".vale.ini", "_vale.ini"];

/** The values the user sets at the command line. */
export interface CLIFlags {
	alertLevel: string;
	built: string;
	glob: string;
	inExt: string;
	inPath: string;
	output: string;
	path: string;
	sources: string;
	filter: string;
	apply: boolean;
	counts: boolean;
	coverage: boolean;
	local: boolean;
	noExit: boolean;
	noColor: boolean;
	plainProgress: boolean;
	normalize: boolean;
	relative: boolean;
	remote: boolean;
	simple: boolean;
	sorted: boolean;
	wrap: boolean;
	version: boolean;
	help: boolean;
	ignoreGlobal: boolean;
}

export function newFlags(partial: Partial<CLIFlags> = {}): CLIFlags {
	return {
		alertLevel: "",
		built: "",
		glob: "*",
		inExt: ".txt",
		inPath: "",
		output: "CLI",
		path: "",
		sources: "",
		filter: "",
		apply: false,
		counts: false,
		coverage: false,
		local: false,
		noExit: false,
		noColor: false,
		plainProgress: false,
		normalize: false,
		relative: false,
		remote: false,
		simple: false,
		sorted: false,
		wrap: false,
		version: false,
		help: false,
		ignoreGlobal: false,
		...partial,
	};
}

export class Config {
	/** Patterns whose matches are replaced by a code block. */
	blockIgnores: Record<string, string[]> = {};
	/** Every rule the configuration mentions. */
	checks: string[] = [];
	/** `[formats]`: unknown extension to known format. */
	formats: Record<string, string> = {};
	/** `[asciidoctor]`: attributes to pass to the converter. */
	asciidoctor: Record<string, string> = {};
	/** `[sphinx]`: a project's code directives and prose roles. */
	sphinx: Record<string, string> = {};
	/** Section to language code. */
	formatToLang: Record<string, string> = {};
	/** `BasedOnStyles` in `[*]`. */
	gBaseStyles: string[] = [];
	/** Rule settings in `[*]`, by rule, saying whether it runs. */
	gChecks: Record<string, boolean> = {};
	/** HTML classes whose contents are skipped. */
	ignoredClasses: string[] = [];
	/** HTML tags whose contents are skipped. */
	ignoredScopes: string[] = [];
	/** The lowest level to report. */
	minAlertLevel = 0;
	/** Vocabularies named at the top level. */
	vocab: string[] = [];
	/** Level overrides, by rule or style. */
	ruleToLevel: Record<string, string> = {};
	/** Scalar overrides, by rule then parameter. */
	ruleToParams: Record<string, Record<string, string>> = {};
	/** `BasedOnStyles`, by section. */
	sBaseStyles: Record<string, string[]> = {};
	/** Rule settings, by section then rule. */
	sChecks: Record<string, Record<string, boolean>> = {};
	/** Level overrides, by section then rule. */
	sLevels: Record<string, Record<string, string>> = {};
	/** Keys a section marked `UNSET`, by section. */
	sUnsets: Record<string, string[]> = {};
	/** Vocabularies a section names, by section. */
	sVocab: Record<string, string[]> = {};
	/** The file each section's `BasedOnStyles` came from. */
	styleSources: Record<string, string> = {};
	/** Every vocabulary loaded, by name. */
	vocabularies: Record<string, Vocabulary> = {};
	/** HTML blocks whose contents are skipped entirely. */
	skippedScopes: string[] = [];
	/** `Transform`: an XSLT stylesheet, by section. */
	stylesheets: Record<string, string> = {};
	/** Patterns whose matches are replaced by inline code. */
	tokenIgnores: Record<string, string[]> = {};
	/** `CommentDelimiters`: the start and end of a comment, by section. */
	commentDelimiters: Record<string, [string, string]> = {};
	/** The template used when converting a YAML rule to a pattern. */
	wordTemplate = "";
	/** The path of the project's `.vale.ini`. */
	rootINI = "";
	/** Every path to search for styles and configuration assets. */
	paths: string[] = [];
	/** Every configuration file the run read, earliest first. */
	configFiles: string[] = [];

	/** The project's accepted terms, from every vocabulary it names. */
	acceptedTokens: string[] = [];
	/** The project's rejected terms. */
	rejectedTokens: string[] = [];

	fallbackPath = "";

	/** Each section's compiled glob. */
	secToPat: Record<string, Glob> = {};
	/** Each section's compiled `if`, for one written `[glob if expr]`. */
	secToCond: Record<string, Condition> = {};
	/** Every style any section turns on. */
	styles: string[] = [];
	/** `View`, by section. */
	views: Record<string, View> = {};

	/** The named scopes found under `config/scopes`, by name. */
	scopes: Record<string, string> = {};
	scopesLoaded = false;

	/** An external API to call for language work. */
	nlpEndpoint = "";

	flags: CLIFlags;

	/** The sections that set `BasedOnStyles`, in the order written. */
	styleKeys: string[] = [];
	/** Every section, in the order written. */
	ruleKeys: string[] = [];

	private readonly cache = new Map<string, unknown>();

	constructor(flags: CLIFlags) {
		this.flags = flags;
	}

	/** Records a configuration file, keeping the order they were read in. */
	addConfigFile(name: string): void {
		if (!this.configFiles.includes(name)) this.configFiles.push(name);
	}

	/** Records a styles path. */
	addStylesPath(p: string): void {
		if (p !== "" && !this.paths.includes(p)) this.paths.push(p);
	}

	/**
	 * The last configuration file read, which is the user's project-agnostic
	 * one.
	 */
	configFile(): string {
		return this.configFiles[this.configFiles.length - 1] ?? "";
	}

	/** The first configuration file read. */
	root(): string {
		const first = this.configFiles[0];
		if (first === undefined) throw new Error("no .vale.ini file found");
		return first;
	}

	/** The last styles path, which is the project's own. */
	stylesPath(): string {
		return this.paths[this.paths.length - 1] ?? "";
	}

	/** Every path to search, or `[""]` when nothing has been set. */
	searchPaths(): string[] {
		return this.paths.length === 0 ? [""] : this.paths;
	}

	/** Every vocabulary any section uses. */
	sectionVocabs(): string[] {
		const names: string[] = [];
		for (const sec of ["*", ...this.ruleKeys]) {
			for (const name of this.sVocab[sec] ?? []) {
				if (!names.includes(name)) names.push(name);
			}
		}
		return names;
	}

	/** What `build` makes for `key`, building it once per configuration. */
	cached<T>(key: string, build: () => T): T {
		if (this.cache.has(key)) return this.cache.get(key) as T;
		const v = build();
		this.cache.set(key, v);
		return v;
	}

	/** Adds vocabulary terms from a file. */
	addWordListFile(name: string, accept: boolean): void {
		const terms = readWordList(name);
		if (accept) this.acceptedTokens.push(...terms);
		else this.rejectedTokens.push(...terms);
	}

	/**
	 * Whether section `sec` applies to a file: its glob matches one of `names`,
	 * and its condition, if it has one, held.
	 */
	sectionApplies(
		sec: string,
		held: Record<string, boolean>,
		...names: string[]
	): boolean {
		if (this.secToCond[sec] !== undefined && held[sec] !== true) return false;

		let pat = this.secToPat[sec];
		if (pat === undefined) {
			// A global key is stored under "*", which no section registers.
			const [g] = splitSection(sec);
			try {
				pat = Glob.compile(g);
			} catch {
				return false;
			}
		}
		for (const n of names) {
			if (n !== "" && pat.match(n)) return true;
		}
		return false;
	}

	/**
	 * Evaluates the conditions of the sections whose glob matches `path`, and
	 * returns the ones that held.
	 */
	heldConditions(path: string, content: string): Record<string, boolean> {
		const held: Record<string, boolean> = {};

		const matched: string[] = [];
		let meta = false;
		for (const [sec, cond] of Object.entries(this.secToCond)) {
			const pat = this.secToPat[sec];
			if (pat !== undefined && pat.match(path)) {
				matched.push(sec);
				meta = meta || cond.readsMeta;
			}
		}
		if (matched.length === 0) return held;

		const fields = newFileFieldsFor(path, content, meta, this.rootINI);
		for (const sec of matched) {
			try {
				held[sec] = this.secToCond[sec]!.holds(fields);
			} catch (err) {
				throw new Error(
					`[${sec}]: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		return held;
	}

	/** One list from the `[sphinx]` section, lower-cased. */
	sphinxNames(key: string): string[] {
		const out: string[] = [];
		for (const raw of (this.sphinx[key] ?? "").split(",")) {
			const n = raw.trim();
			if (n !== "") out.push(n.toLowerCase());
		}
		return out;
	}

	/** Reads every named scope on the search paths into `scopes`. */
	loadScopes(): void {
		if (this.scopesLoaded) return;
		this.scopesLoaded = true;

		for (const root of this.searchPaths()) {
			const dir = nodePath.join(root, SCOPE_DIR);
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				continue;
			}
			entries.sort();
			for (const name of entries) {
				if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
				const full = nodePath.join(dir, name);
				if (isDir(full)) continue;
				loadScopeFile(this, full);
			}
		}
	}

	toJSON(): unknown {
		const {
			flags: _flags,
			cache: _cache,
			...rest
		} = this as unknown as Record<string, unknown>;
		return rest;
	}
}

// Imported late so that `condition.ts` need not know about `Config`.
import { newFileFields as newFileFieldsFor } from "./condition.ts";
import { loadScopeFile } from "./scopes.ts";

/** A configuration with its default values. */
export function newConfig(flags: CLIFlags): Config {
	const cfg = new Config(flags);
	const found = defaultStylesPath();
	if (!flags.ignoreGlobal && isDir(found)) cfg.addStylesPath(found);
	return cfg;
}

/**
 * The path of the global configuration file.
 *
 * It is not created automatically: there is no real notion of a "default"
 * configuration, only a location where one may be put.
 */
export function defaultConfig(): string {
	return xdg.configFile(nodePath.join("vale", ".vale.ini"));
}

/**
 * The default styles directory.
 *
 * Only used when neither the project's nor the global configuration sets a
 * `StylesPath`.
 */
export function defaultStylesPath(): string {
	const fromEnv = process.env.VALE_STYLES_PATH;
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	return dirName(xdg.dataFile(nodePath.join("vale", "styles", "config.yml")));
}

/** Locates a Vale resource by looking in one of the configuration folders. */
export function findConfigAsset(cfg: Config, name: string, dir: string): string {
	return getConfigAsset(name, cfg.searchPaths(), [dir]);
}

/** Locates a Vale resource anywhere on the search paths. */
export function findAsset(cfg: Config, p: string): string {
	if (p === "") return "";

	for (const root of cfg.searchPaths()) {
		const inPath = nodePath.join(root, p);
		if (fileExists(inPath)) return inPath;
	}

	const found = getConfigAsset(p, cfg.searchPaths(), CONFIG_DIRS);
	if (found !== "") return found;

	const relative = determinePath(cfg.flags.path, p);
	if (fileExists(relative)) return relative;

	return "";
}

function getConfigAsset(
	target: string,
	paths: readonly string[],
	dirs: readonly string[],
): string {
	for (const p of paths) {
		for (const dir of dirs) {
			const full = nodePath.join(p, dir, target);
			if (fileExists(full)) return full;
		}
	}
	return "";
}

/** Every user-defined ignore file under a styles path. */
export function ignoreFiles(stylesPath: string): string[] {
	const root = nodePath.join(stylesPath, IGNORE_DIR);
	if (!isDir(root)) return [];
	const out: string[] = [];
	walk(root, (entry) => {
		if (entry.isFile && entry.name.endsWith(".txt")) out.push(entry.path);
	});
	return out;
}

/** The packages a `.vale.ini` asks for. */
export function getPackages(src: string): string[] {
	const uCfg = parseINI(readFileSync(src, "utf8"), { allowShadows: true });
	return uCfg.section("").key("Packages").strings(",");
}

// --- loading --------------------------------------------------------------

const LOAD_OPTIONS = {
	allowShadows: true,
	spaceBeforeInlineComment: true,
};

/**
 * Loads Vale's configuration the way the command line does.
 *
 * A `dry` run -- `sync` -- cannot expect the `StylesPath` to be fully formed
 * yet, since some of what it names has not been downloaded.
 */
export function readPipeline(flags: CLIFlags, dry: boolean): Config {
	const config = newConfig(flags);
	validateFlags(config);

	fromFile(config, dry);

	const sources = pipeConfig(config);
	if (sources.length > 0) {
		config.flags.sources = sources.join(",");
		fromFile(config, true);
	}

	return config;
}

/** Loads an INI configuration from the files the flags name. */
export function fromFile(cfg: Config, dry: boolean): INIFile {
	return loadINI(cfg, dry);
}

/** Loads an INI configuration from a string, for tests and `--config -`. */
export function fromString(src: string, cfg: Config, dry: boolean): INIFile {
	const uCfg = shadowLoadFrom([{ text: src, origin: null }]);
	return processConfig(uCfg, cfg, dry);
}

/**
 * The configuration two files would produce: one from the project, one from
 * the user's own directory. Used by `vale ls-config`.
 */
export function mockLoad(project: string, local: string, cfg: Config): void {
	const uCfg = shadowLoadFrom([
		{ text: readSource(project), origin: project },
		{ text: readSource(local), origin: local },
	]);
	processConfig(uCfg, cfg, true);
}

function validateFlags(cfg: Config): void {
	if (cfg.flags.path !== "" && !fileExists(cfg.flags.path)) {
		throw newE100("--config", new Error(`path '${cfg.flags.path}' does not exist`));
	}
}

/**
 * The configuration files a package shipped, which `sync` wrote into
 * `.vale-config`.
 */
function pipeConfig(cfg: Config): string[] {
	const sources: string[] = [];
	const pipeline = nodePath.join(cfg.stylesPath(), PIPE_DIR);
	if (isDir(pipeline) && cfg.flags.sources.length === 0) {
		for (const name of readdirSync(pipeline).sort()) {
			const full = nodePath.join(pipeline, name);
			if (isDir(full)) continue;
			sources.push(full);
		}
		if (sources.length > 0) sources.push(...cfg.configFiles);
	}
	return sources;
}

function loadINI(cfg: Config, dry: boolean): INIFile {
	const sources: string[] = [];

	// The user's configuration directory is loaded *in addition to* any other
	// source rather than instead of it, and is read last so that it can
	// customize a project it knows nothing about. A dry run is the exception:
	// it has to work against a single file, so this one is read only when it is
	// the only one.
	const defaultCfg = defaultConfig();
	const hasDefault = fileExists(defaultCfg) && !cfg.flags.ignoreGlobal;

	if (hasDefault && !dry) {
		sources.push(defaultCfg);
		cfg.flags.local = true;
		cfg.addConfigFile(defaultCfg);
	}

	const base = findLocalConfig(CONFIG_NAMES);
	cfg.rootINI = base;

	if (cfg.flags.sources !== "") {
		// Not reachable from the command line, but a package that ships
		// configuration files goes through here.
		for (const source of cfg.flags.sources.split(",")) {
			sources.push(absPath(source));
		}
	} else if (cfg.flags.path !== "") {
		sources.push(cfg.flags.path);
		cfg.addConfigFile(cfg.flags.path);
	} else if (process.env.VALE_CONFIG_PATH !== undefined) {
		sources.push(process.env.VALE_CONFIG_PATH);
		cfg.addConfigFile(process.env.VALE_CONFIG_PATH);
	} else if (base !== "") {
		sources.push(base);
		cfg.addConfigFile(base);
	} else if (hasDefault && dry) {
		// The global file is the only one available, so a dry run has to read
		// it to resolve values such as `StylesPath`.
		sources.push(defaultCfg);
		cfg.flags.local = true;
		cfg.addConfigFile(defaultCfg);
	}

	if (ALERT_LEVELS.includes(cfg.flags.alertLevel as never)) {
		cfg.minAlertLevel = LEVEL_TO_INT[cfg.flags.alertLevel]!;
	}

	if (base === "" && cfg.configFiles.length === 0 && !dry) {
		throw new ValeError({
			code: "E100",
			context: ".vale.ini not found",
			msg: "no config file found",
		});
	}

	const uCfg = processSources(cfg, sources);
	return processConfig(uCfg, cfg, dry);
}

/**
 * Looks for a configuration file in the working directory and its ancestors,
 * then in the user's home directory.
 */
export function findLocalConfig(names: readonly string[]): string {
	let cwd = process.cwd();
	for (;;) {
		const parent = dirName(cwd);
		for (const name of names) {
			const loc = nodePath.join(cwd, name);
			if (fileExists(loc) && !isDir(loc)) return loc;
		}
		if (cwd === parent) break;
		cwd = parent;
	}

	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (home === "") return "";
	for (const name of names) {
		const loc = nodePath.join(home, name);
		if (fileExists(loc) && !isDir(loc)) return loc;
	}

	return "";
}

interface Source {
	text: string;
	/** The file it came from, or null for a string. */
	origin: string | null;
}

function readSource(p: string): string {
	try {
		return readFileSync(p, "utf8");
	} catch {
		// Loose loading: a file that is not there contributes nothing, which is
		// what lets `sync` run before a package has been downloaded.
		return "";
	}
}

function processSources(cfg: Config, sources: readonly string[]): INIFile {
	if (sources.length === 0) {
		// A dry run has no sources when the only configuration file is the
		// global one, which `sync` resolves later through `Config.root`.
		return emptyINI(LOAD_OPTIONS);
	}
	if (sources.length === 1) {
		cfg.flags.path = sources[0]!;
		return shadowLoadFrom([{ text: readSource(sources[0]!), origin: sources[0]! }]);
	}

	const loaded = shadowLoadFrom(
		sources.map((s) => ({ text: readSource(s), origin: s })),
	);
	cfg.flags.path = sources[sources.length - 1]!;
	cfg.styleSources = styleSources(sources);
	return loaded;
}

/**
 * Loads several sources into one `File`, stacking each key's values.
 *
 * The first source's value stays first and every later one becomes a shadow,
 * which is what lets an option choose its own layer.
 */
function shadowLoadFrom(sources: readonly Source[]): INIFile {
	const primary = emptyINI(LOAD_OPTIONS);
	let first = true;

	for (const source of sources) {
		const file = parseINI(source.text, LOAD_OPTIONS);
		expandPaths(file, source.origin);
		if (first) {
			mergeAll(primary, file, true);
			first = false;
		} else {
			mergeAll(primary, file, false);
		}
	}

	return primary;
}

function mergeAll(primary: INIFile, other: INIFile, initial: boolean): void {
	for (const section of other.sections()) {
		const into = primary.newSection(section.name);
		for (const key of section.keys()) {
			const existing = into.getKey(key.name);
			if (existing === undefined) {
				const created = into.newKey(key.name, key.value);
				// A key duplicated within one file already has shadows of its
				// own; they belong to the same layer and are carried over.
				for (const shadow of key.shadows) created.addShadow(shadow);
			} else if (initial) {
				existing.addShadow(key.value);
			} else {
				existing.addShadow(key.value);
				for (const shadow of key.shadows) existing.addShadow(shadow);
			}
		}
	}
}

/** The keys whose values name a path, and so are resolved against their file. */
const PATH_KEYS = ["StylesPath"];

/**
 * Resolves the path-valued keys against the file that set them.
 *
 * A `StylesPath` is written relative to its own `.vale.ini`, not to wherever
 * Vale happened to be run from.
 */
function expandPaths(file: INIFile, origin: string | null): void {
	let base: string;
	if (origin !== null) {
		base = dirName(absPath(origin));
		if (baseName(base) === PIPE_DIR) {
			// A package's `StylesPath` named the styles it shipped with, which
			// `sync` has since merged into the project's. Resolved from here it
			// is a directory beside this file that does not exist -- and, as the
			// last path added, where the next sync would install.
			file.section("").deleteKey("StylesPath");
			return;
		}
	} else {
		base = process.cwd();
	}

	for (const section of file.sections()) {
		for (const key of section.keys()) {
			if (!PATH_KEYS.includes(key.name)) continue;
			const resolved = [key.value, ...key.shadows].map((v) =>
				nodePath.isAbsolute(v) ? v : nodePath.join(base, v),
			);
			key.setValue(resolved[0]!);
			for (const v of resolved.slice(1)) key.addShadow(v);
		}
	}
}

/**
 * Maps each section that sets `BasedOnStyles` to the last configuration file
 * that sets it there, so a dropped style can say which package it came from.
 */
function styleSources(sources: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const src of sources) {
		let file: INIFile;
		try {
			file = parseINI(readSource(src), LOAD_OPTIONS);
		} catch {
			continue;
		}
		for (const sec of file.sections()) {
			if (sec.hasKey("BasedOnStyles")) out[sec.name] = src;
		}
	}
	return out;
}

/**
 * The package a configuration file came from, or "".
 *
 * `vale sync` writes a package's `.vale.ini` to `.vale-config/<n>-<Name>.ini`.
 */
export function packageOf(p: string): string {
	if (baseName(dirName(p)) !== PIPE_DIR) return "";
	const ext = extName(p);
	const name = ext === "" ? baseName(p) : baseName(p).slice(0, -ext.length);
	const dash = name.indexOf("-");
	return dash < 0 ? name : name.slice(dash + 1);
}

// --- option handling ------------------------------------------------------

/** Trims each value, drops the empty ones, and keeps the first of each. */
function mergeValues(shadows: readonly string[]): string[] {
	const values: string[] = [];
	for (const v of shadows) {
		const entry = v.trim();
		if (entry !== "" && !values.includes(entry)) values.push(entry);
	}
	return values;
}

/**
 * Splits a key and its shadows on commas, keeping a comma escaped as `\,`
 * inside its pattern so that a quantifier like `{2,}` survives.
 */
function patternsWithShadows(key: Key): string[] {
	const values: string[] = [];
	for (const v of key.valueWithShadows()) {
		values.push(...splitEscaped(v, ","));
	}
	return mergeValues(values);
}

/** Splits on `delim`, treating `\<delim>` as a literal delimiter. */
export function splitEscaped(s: string, delim: string): string[] {
	const vals: string[] = [];
	let buf = "";
	let escape = false;
	for (const r of s) {
		if (escape) {
			if (r !== delim) buf += "\\";
			buf += r;
			escape = false;
		} else if (r === "\\") {
			escape = true;
		} else if (r === delim) {
			vals.push(buf);
			buf = "";
		} else {
			buf += r;
		}
	}
	if (escape) buf += "\\";
	vals.push(buf);
	return vals;
}

/** The value a key was given last across the merged sources. */
function lastValue(key: Key): string {
	const values = key.valueWithShadows();
	return values[values.length - 1]!;
}

/** Drops what earlier sections said about a rule, so defaults apply again. */
const UNSET_VALUE = "UNSET";

/** The spelled-out empty list: nothing listed, and nothing inherited. */
const NONE_VALUE = "NONE";

/**
 * Reads a list key.
 *
 * The values arrive merged across the configuration's layers, so `NONE`
 * clears whatever came before it and the last layer to say `NONE` wins.
 */
function valuesAfterNone(key: Key): string[] {
	let values = key.stringsWithShadows(",");
	for (let i = values.length - 1; i >= 0; i--) {
		if (values[i]!.trim() === NONE_VALUE) {
			values = values.slice(i + 1);
			break;
		}
	}
	return mergeValues(values);
}

/**
 * A php.ini-style parameter key: `Std.SentenceLength[max]`.
 *
 * The name half must be a rule -- it contains a dot -- and must not itself
 * hold brackets, which rule names are forbidden to.
 */
const RULE_PARAM = /^([^[\]]+\.[^[\]]+)\[([A-Za-z][A-Za-z0-9]*)\]$/;

/**
 * The fields an INI value cannot express or should not own: lists, mappings,
 * identity, and the rule's own prose.
 *
 * Changing one of these is authoring, which is what extending a rule in a
 * style is for.
 */
const STRUCTURAL_KEYS = [
	"extends",
	"name",
	"path",
	"tests",
	"message",
	"description",
	"link",
	"tokens",
	"swap",
	"exceptions",
	"filters",
	"ignore",
	"raw",
	"either",
];

/**
 * Intercepts a parameter key, recording it and reporting whether it was one.
 *
 * Parameters apply when the rule compiles, so unlike levels they hold wherever
 * the rule runs.
 */
function asRuleParam(key: string, val: string, cfg: Config): boolean {
	const groups = RULE_PARAM.exec(key);
	if (groups === null) return false;

	const name = groups[1]!;
	const param = groups[2]!.toLowerCase();

	if (param === "level") {
		// The classic key already says this, and has for a decade; a second
		// spelling that shadows it helps nobody.
		throw newE201FromTarget(
			`set a level with '${name} = ${val}'`,
			key,
			cfg.rootINI,
		);
	}
	if (STRUCTURAL_KEYS.includes(param)) {
		throw newE201FromTarget(
			`'${param}' is not adjustable from configuration; extend '${name}' in a style instead`,
			key,
			cfg.rootINI,
		);
	}

	cfg.ruleToParams[name] ??= {};
	cfg.ruleToParams[name]![param] = val;
	return true;
}

/**
 * Whether `key` names a rule that should run, recording any level it was
 * given in `levels`.
 *
 * A level set under a section belongs to that section: writing every one into
 * a single map made the last section in the file decide the level everywhere.
 */
function validateLevel(
	key: string,
	val: string,
	levels: Record<string, string>,
): boolean {
	const options = ["YES", "suggestion", "warning", "error"];
	if (val === "NO") return false;
	if (!options.includes(val)) {
		// Read as off, as before, but said out loud: a typo here silently
		// disabled the rule, and a misspelled key was never read at all.
		if (key.includes(".")) {
			warn(
				`'${key} = ${val}' isn't YES, NO, UNSET, or a level; Vale is switching the rule off.`,
			);
		} else {
			warn(`'${key}' isn't a section option; Vale is ignoring it.`);
		}
		return false;
	}
	if (val !== "YES") levels[key] = val;
	return true;
}

/** Reads a `BasedOnStyles` key. */
function baseStyles(key: Key): string[] {
	return valuesAfterNone(key);
}

/** The keys a `[sphinx]` section may set. */
const SPHINX_KEYS = ["CodeDirectives", "ProseRoles"];

const CORE_ERROR =
	"'%s' is a core option; it should be defined above any syntax-specific options (`[...]`).";

type SyntaxOpt = (label: string, sec: Section, cfg: Config) => void;

const SYNTAX_OPTS: Record<string, SyntaxOpt> = {
	Vocab(lbl, sec, cfg) {
		const names = valuesAfterNone(sec.key("Vocab"));
		for (const name of names) {
			loadVocabulary(name, cfg);
			// A vocabulary's own `Terms` and `Avoid` run only where a section
			// names it; the file turns them on for its own files.
			cfg.gChecks[`Vale.${name}.Terms`] = false;
			cfg.gChecks[`Vale.${name}.Avoid`] = false;
		}
		cfg.sVocab[lbl] = [...(cfg.sVocab[lbl] ?? []), ...names];
	},

	BasedOnStyles(lbl, sec, cfg) {
		const [g] = splitSection(lbl);
		let pat: Glob;
		try {
			pat = Glob.compile(g);
		} catch {
			throw newE201FromTarget(
				`The glob pattern '${lbl}' could not be compiled.`,
				lbl,
				cfg.flags.path,
			);
		}
		cfg.secToPat[lbl] ??= pat;

		const sStyles = baseStyles(sec.key("BasedOnStyles"));
		cfg.styles.push(...sStyles);
		cfg.styleKeys.push(lbl);
		cfg.sBaseStyles[lbl] = sStyles;
	},

	IgnorePatterns(label, sec, cfg) {
		cfg.blockIgnores[label] = sec.key("IgnorePatterns").strings(",");
	},

	BlockIgnores(label, sec, cfg) {
		cfg.blockIgnores[label] = patternsWithShadows(sec.key("BlockIgnores"));
	},

	CommentDelimiters(label, sec, cfg) {
		const d = mergeValues(sec.key("CommentDelimiters").stringsWithShadows(","));
		if (d.length !== 2) {
			throw newE201FromTarget(
				`CommentDelimiters must be a comma-separated list of two delimiters, but got ${d.length} items`,
				label,
				cfg.flags.path,
			);
		}
		cfg.commentDelimiters[label] = [d[0]!, d[1]!];
	},

	TokenIgnores(label, sec, cfg) {
		cfg.tokenIgnores[label] = patternsWithShadows(sec.key("TokenIgnores"));
	},

	Transform(label, sec, cfg) {
		const candidate = sec.key("Transform").string();
		cfg.stylesheets[label] = determinePath(cfg.configFile(), candidate);
	},

	Lang(label, sec, cfg) {
		cfg.formatToLang[label] = sec.key("Lang").string();
	},

	View(label, sec, cfg) {
		const name = sec.key("View").string();
		const p = findConfigAsset(cfg, `${name}.yml`, VIEW_DIR);
		if (p === "") throw new Error(`view '${name}' not found`);
		cfg.views[label] = newView(p);
	},
};

type GlobalOpt = (sec: Section, cfg: Config) => void;

const GLOBAL_OPTS: Record<string, GlobalOpt> = {
	BasedOnStyles(sec, cfg) {
		cfg.gBaseStyles = baseStyles(sec.key("BasedOnStyles"));
		cfg.styles.push(...cfg.gBaseStyles);
	},
	IgnorePatterns(sec, cfg) {
		cfg.blockIgnores["*"] = sec.key("IgnorePatterns").strings(",");
	},
	BlockIgnores(sec, cfg) {
		cfg.blockIgnores["*"] = patternsWithShadows(sec.key("BlockIgnores"));
	},
	TokenIgnores(sec, cfg) {
		cfg.tokenIgnores["*"] = patternsWithShadows(sec.key("TokenIgnores"));
	},
	Lang(sec, cfg) {
		cfg.formatToLang["*"] = sec.key("Lang").string();
	},
};

type CoreOpt = (sec: Section, cfg: Config) => void;

const CORE_OPTS: Record<string, CoreOpt> = {
	StylesPath(sec, cfg) {
		const paths = sec.key("StylesPath").valueWithShadows();
		for (const p of paths) {
			cfg.addStylesPath(p);
			if (!fileExists(p)) {
				// The value was expanded on load, so the line is found by the
				// path it was written as.
				const written = (v: string): boolean => {
					const cleaned = nodePath.normalize(v);
					return cleaned !== "." && p.endsWith(cleaned);
				};
				throw newE201FromKey(
					cfg.configFiles,
					"StylesPath",
					written,
					`The StylesPath '${p}' doesn't exist.`,
				);
			}
		}
	},

	MinAlertLevel(sec, cfg) {
		if (ALERT_LEVELS.includes(cfg.flags.alertLevel as never)) return;
		const values = sec.key("MinAlertLevel").stringsWithShadows(",");
		const level =
			values.length > 0
				? values[values.length - 1]!
				: sec.key("MinAlertLevel").string();
		const index = LEVEL_TO_INT[level];
		if (index === undefined) {
			throw newE201FromTarget(
				"MinAlertLevel must be 'suggestion', 'warning', or 'error'.",
				level,
				cfg.flags.path,
			);
		}
		cfg.minAlertLevel = index;
	},

	IgnoredScopes(sec, cfg) {
		cfg.ignoredScopes = mergeValues(
			sec.key("IgnoredScopes").stringsWithShadows(","),
		);
	},

	WordTemplate(sec, cfg) {
		cfg.wordTemplate = sec.key("WordTemplate").string();
	},

	SkippedScopes(sec, cfg) {
		cfg.skippedScopes = mergeValues(
			sec.key("SkippedScopes").stringsWithShadows(","),
		);
	},

	IgnoredClasses(sec, cfg) {
		cfg.ignoredClasses = mergeValues(
			sec.key("IgnoredClasses").stringsWithShadows(","),
		);
	},

	Vocab(sec, cfg) {
		cfg.vocab = valuesAfterNone(sec.key("Vocab"));
		for (const v of cfg.vocab) {
			const vocab = loadVocabulary(v, cfg);
			cfg.acceptedTokens.push(...vocab.accepted);
			cfg.rejectedTokens.push(...vocab.rejected);
		}
	},

	NLPEndpoint(sec, cfg) {
		cfg.nlpEndpoint = sec.key("NLPEndpoint").mustString("");
		const values = sec.key("NLPEndpoint").stringsWithShadows(",");
		if (values.length > 0) cfg.nlpEndpoint = values[values.length - 1]!;
	},
};

/** Keys at the top level that something other than `CORE_OPTS` reads. */
const NON_OPT_KEYS = ["Packages"];

/** Reads a loaded INI file into `cfg`. */
export function processConfig(uCfg: INIFile, cfg: Config, dry: boolean): INIFile {
	const core = uCfg.section("");
	const global = uCfg.section("*");
	const formats = uCfg.section("formats");
	const adoc = uCfg.section("asciidoctor");
	const sphinx = uCfg.section("sphinx");

	for (const k of core.keyStrings()) {
		const opt = CORE_OPTS[k];
		if (opt !== undefined) {
			try {
				opt(core, cfg);
			} catch (err) {
				if (!dry) throw err;
			}
		} else if (SYNTAX_OPTS[k] !== undefined) {
			throw newE201FromTarget(`'${k}' is a syntax-specific option`, k, cfg.rootINI);
		} else if (!NON_OPT_KEYS.includes(k)) {
			// Nothing reads a key we do not recognize here, so letting it pass
			// quietly means the configuration says something Vale never hears.
			// The delimiters include `:`, which is what makes this worth saying:
			// a URL on a line of its own parses as the key `https` with the rest
			// for a value, and the package it was meant to name is never
			// installed.
			warn(`'${k}' isn't a core option; Vale is ignoring it.`);
		}
	}

	for (const k of formats.keyStrings()) {
		cfg.formats[k] = formats.key(k).string();
	}

	for (const k of adoc.keyStrings()) {
		cfg.asciidoctor[k] = adoc.key(k).string();
	}

	for (const k of sphinx.keyStrings()) {
		if (!SPHINX_KEYS.includes(k)) {
			warn(`'${k}' isn't a sphinx option; Vale is ignoring it.`);
			continue;
		}
		cfg.sphinx[k] = sphinx.key(k).string();
	}

	for (const k of global.keyStrings()) {
		if (k === "Vocab") continue; // read below, once every rule setting is known
		if (CORE_OPTS[k] !== undefined) {
			throw newE201FromTarget(CORE_ERROR.replace("%s", k), k, cfg.rootINI);
		}
		const opt = GLOBAL_OPTS[k];
		if (opt !== undefined) {
			opt(global, cfg);
			continue;
		}
		if (SYNTAX_OPTS[k] !== undefined) {
			throw newE201FromTarget(`'${k}' is a syntax-specific option`, k, cfg.rootINI);
		}
		const value = lastValue(global.key(k));
		if (asRuleParam(k, value, cfg)) continue;
		if (value === UNSET_VALUE) {
			// Nothing precedes the global section, so there is nothing to unset.
			continue;
		}
		cfg.gChecks[k] = validateLevel(k, value, cfg.ruleToLevel);
		cfg.checks.push(k);
	}

	// `[*]` names vocabularies for every file, with rules of their own that are
	// on unless a setting in `[*]` says otherwise.
	if (global.hasKey("Vocab")) {
		const names = valuesAfterNone(global.key("Vocab"));
		for (const name of names) {
			try {
				loadVocabulary(name, cfg);
			} catch (err) {
				if (!dry) throw err;
			}
			for (const rule of [".Terms", ".Avoid"]) {
				const key = `Vale.${name}${rule}`;
				if (!(key in cfg.gChecks)) cfg.gChecks[key] = true;
			}
		}
		cfg.sVocab["*"] = names;
	}

	const reserved = ["*", DEFAULT_SECTION, "formats", "asciidoctor", "sphinx"];
	for (const sec of uCfg.sectionStrings()) {
		if (reserved.includes(sec)) continue;

		// `[*.md if .Meta.draft]` applies to the files its glob matches for
		// which its condition holds.
		const [g, cond] = splitSection(sec);
		cfg.secToPat[sec] = Glob.compile(g);
		if (cond !== "") {
			try {
				cfg.secToCond[sec] = new Condition(cond);
			} catch (err) {
				throw newE201FromTarget(
					`[${sec}]: ${err instanceof Error ? err.message : String(err)}`,
					sec,
					cfg.rootINI,
				);
			}
		}

		const section = uCfg.section(sec);
		const syntaxMap: Record<string, boolean> = {};
		const levelMap: Record<string, string> = {};

		for (const k of section.keyStrings()) {
			const opt = SYNTAX_OPTS[k];
			if (opt !== undefined) {
				try {
					opt(sec, section, cfg);
				} catch (err) {
					if (!dry) throw err;
				}
				continue;
			}
			if (CORE_OPTS[k] !== undefined) {
				throw newE201FromTarget(CORE_ERROR.replace("%s", k), k, cfg.rootINI);
			}
			const value = lastValue(section.key(k));
			if (asRuleParam(k, value, cfg)) continue;
			if (value === UNSET_VALUE) {
				cfg.sUnsets[sec] = [...(cfg.sUnsets[sec] ?? []), k];
				cfg.checks.push(k);
				continue;
			}
			syntaxMap[k] = validateLevel(k, value, levelMap);
			cfg.checks.push(k);
		}

		cfg.ruleKeys.push(sec);
		cfg.sChecks[sec] = syntaxMap;
		cfg.sLevels[sec] = levelMap;
	}

	return uCfg;
}

/** Reads a vocabulary by name, once. */
export function loadVocabulary(root: string, cfg: Config): Vocabulary {
	const cached = cfg.vocabularies[root];
	if (cached !== undefined) return cached;

	let target = "";
	const tried: string[] = [];
	for (const p of cfg.searchPaths()) {
		const opt = nodePath.join(p, VOCAB_DIR, root);
		tried.push(opt);
		if (isDir(opt)) {
			target = opt;
			break;
		}
	}

	if (target === "") {
		throw newE100(
			"vocab",
			new Error(`'${root}' vocabulary not found; searched: ${tried.join(", ")}`),
		);
	}

	const vocab = newVocabulary();
	walk(target, (entry) => {
		if (!entry.isFile) return;
		switch (entry.name) {
			case "accept.txt":
				vocab.accepted.push(...readWordList(entry.path));
				break;
			case "reject.txt":
				vocab.rejected.push(...readWordList(entry.path));
				break;
			default:
				if (VOCAB_FILES.includes(entry.name)) {
					parseVocabYAML(
						readFileSync(entry.path, "utf8"),
						vocab,
						toSlash(entry.path),
						(name) => findAffix(cfg, name),
					);
				}
				break;
		}
	});

	cfg.vocabularies[root] = vocab;
	return vocab;
}

/** Loads INI text into an existing file, for a caller stacking sources. */
export { emptyINI, loadInto, parseINI };

/** Whether a styles path looks usable. */
export function stylesPathExists(p: string): boolean {
	return p !== "" && existsSync(p);
}

/**
 * Where the affix file a vocabulary named was found, or "".
 *
 * Looked up the way a spelling rule's dictionaries are: in each search path's
 * `config/dictionaries` folder, then in `$DICPATH`.
 */
export function findAffix(cfg: Config, name: string): string {
	if (name === "") return "";

	const file = `${name}.aff`;
	const roots = cfg.searchPaths().map((p) => nodePath.join(p, DICT_DIR));

	const dicpath = process.env.DICPATH;
	if (dicpath !== undefined && dicpath !== "") roots.push(dicpath);

	for (const root of roots) {
		const candidate = nodePath.join(root, file);
		if (fileExists(candidate)) return candidate;
	}
	return "";
}
