/**
 * Loading styles from disk, compiling their rules, and deciding which of them
 * a run can use.
 *
 * Compiling is the expensive half of loading a rule -- parsing the YAML and,
 * mostly, handing its patterns to the regular-expression engine -- so a rule
 * the configuration can never run is not compiled at all. That test errs
 * toward compiling: nothing downstream can make a skip wrong, since in-text
 * comments only disable and `--filter` selects from what the configuration
 * already loaded.
 */

import { readFileSync } from "node:fs";
import {
	type Config,
	checkName,
	type File,
	fileExists,
	getPackages,
	isDir,
	isTestFile,
	joinPath,
	type NLPInfo,
	newE100,
	newE201FromKey,
	newE201FromPosition,
	newE201FromTarget,
	newNLPInfo,
	styleName,
	termPattern,
	walk,
} from "@vale-ts/core";
import { buildRule } from "./build.ts";
import type { BaseCheck } from "./decode.ts";
import {
	cloneRule,
	DEFAULT_RULES,
	DEFAULT_STYLES,
	parseDefinition,
	type Rule,
} from "./definition.ts";
import { filter } from "./filter.ts";
import { flatten, resolveRule } from "./inherit.ts";
import { docSelectorMap, expandScopes, scopeBases } from "./scope.ts";
import { compileSelector, portableSelector } from "./selector.ts";
import { Substitution } from "./substitution.ts";
import { stringInSlice } from "./util.ts";

/** One `doc(...)` selector a rule declared. */
export interface Selection {
	id: string;
	/** The CSS selector source, as written. */
	sel: string;
}

/** Loads and validates the rules a run will use. */
export class Manager {
	readonly config: Config;

	private readonly scopes = new Set<string>();
	private readonly scopeRules = new Map<string, string[]>();
	private readonly docs = new Map<string, string>();
	private compiled = new Map<string, Rule>();
	private readonly styles: string[] = [];
	private tagging = false;

	constructor(config: Config) {
		this.config = config;
	}

	/**
	 * Loads the rule definitions the configuration asks for.
	 *
	 * A constructor cannot be the whole story because loading reads the file
	 * system and may fail on a style the configuration names, so `create` does
	 * the work and `new Manager(cfg)` leaves the manager empty -- which is what
	 * a caller adding rules by hand wants.
	 */
	static create(config: Config): Manager {
		const mgr = new Manager(config);

		// Named scopes come before the rules that use them.
		config.loadScopes();

		mgr.loadDefaultRules();
		mgr.loadStyles(config.styles);

		for (const chk of config.checks) {
			// A rule must be associated with a style: `Style.Rule`.
			if (!chk.includes(".")) continue;
			const parts = chk.split(".");
			if (mgr.hasStyle(parts[0]!)) continue;

			// A rule outside any loaded style is loaded on its own. Every
			// segment after the style is a path component, so
			// `Std.dates.TimeFormat` is `Std/dates/TimeFormat.yml`.
			const fName = `${parts.slice(1).join("/")}.yml`;
			for (const p of config.searchPaths()) {
				const path = joinPath(p, parts[0]!, fName);
				if (!fileExists(path)) continue;
				mgr.addCheckFile(chk, path);
			}
		}

		mgr.compiled = filter(mgr);
		return mgr;
	}

	/** Every registered rule, by name. */
	rules(): Map<string, Rule> {
		return this.compiled;
	}

	/** Whether a rule with this name is registered. */
	hasRule(name: string): boolean {
		return this.compiled.has(name);
	}

	/** Adds a rule the caller built. */
	addRule(name: string, rule: Rule): void {
		if (this.compiled.has(name)) {
			throw new Error(`the rule '${name}' has already been added`);
		}
		this.compiled.set(name, rule);
	}

	/**
	 * Maps an alert's check name back to the rule that defines it.
	 *
	 * Most alerts carry their rule's name already. A `consistency` rule names
	 * its alerts `Style.Rule.<term>`, and a rule may itself sit in a
	 * subdirectory (`Std.dates.TimeFormat`), so neither dot-counting nor
	 * position says where the rule ends: the longest known prefix does. An
	 * unknown name falls back to its first two segments, which is the
	 * historical reading.
	 */
	ruleForAlert(name: string): string {
		if (this.compiled.has(name)) return name;

		let prefix = name;
		while (prefix.includes(".")) {
			prefix = prefix.slice(0, prefix.lastIndexOf("."));
			if (this.compiled.has(prefix)) return prefix;
		}

		const parts = name.split(".");
		if (parts.length > 2) return `${parts[0]}.${parts[1]}`;
		return name;
	}

	/** Adds the rule in the file at `path` under `name`. */
	addRuleFromFile(name: string, path: string): void {
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch (err) {
			throw newE100(path, err);
		}
		this.addCheck(content, name, path);
	}

	/** Whether any registered rule names this scope. */
	hasScope(scope: string): boolean {
		return this.scopes.has(scope);
	}

	/** The rules whose scope asks for `scope` blocks. */
	rulesForScope(scope: string): string[] {
		return this.scopeRules.get(scope) ?? [];
	}

	/** Whether part-of-speech tagging is needed. */
	needsTagging(): boolean {
		return this.tagging;
	}

	/** Every `doc(...)` selector any rule declared, in a stable order. */
	selections(): Selection[] {
		const found: Selection[] = [];
		// Stored in the dialect the walker matches with, so the selector the
		// manager validated and the one `css-select` runs are the same.
		for (const [id, sel] of this.docs) {
			found.push({ id, sel: portableSelector(sel) });
		}
		found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return found;
	}

	/** The language work this file needs, before the linter narrows it. */
	assignNLP(f: File): NLPInfo {
		return newNLPInfo({
			scope: f.realExt,
			segmentation: this.hasScope("sentence"),
			splitting: this.hasScope("paragraph"),
			tagging: this.needsTagging(),
			endpoint: f.nlp.endpoint,
			lang: f.nlp.lang,
		});
	}

	// --- loading ------------------------------------------------------------

	private addStyle(path: string): void {
		const sources: Array<{ name: string; path: string }> = [];

		walk(path, (entry) => {
			if (
				entry.isDirectory &&
				entry.path !== path &&
				(entry.name.startsWith(".") || entry.name.startsWith("_"))
			) {
				// A subdirectory joins its rules' names, which means YAML
				// parked under a style -- drafts, retired rules -- now loads. A
				// dot or underscore prefix keeps a directory inert, the same
				// convention the test-file walk uses.
				return false;
			}
			if (entry.isDirectory || !entry.name.endsWith(".yml")) return;
			if (isTestFile(entry.name)) {
				// A rule's cases live beside it, so the style directory holds
				// YAML that is not a rule. Loaded as one it fails on `extends`,
				// and the whole configuration stops.
				return;
			}
			sources.push({ name: checkName(path, entry.path), path: entry.path });
			return;
		});

		for (const src of sources) {
			// A rule already loaded under this name is not re-read: the first
			// search path to define it wins.
			if (this.compiled.has(src.name)) continue;

			// Nor is one the configuration can never run.
			if (!this.enabledSomewhere(src.name)) continue;

			let data: string;
			try {
				data = readFileSync(src.path, "utf8");
			} catch (err) {
				throw newE201FromPosition(
					err instanceof Error ? err.message : String(err),
					src.path,
					1,
				);
			}
			this.addCheck(data, src.name, src.path);
		}
	}

	private addCheckFile(chkName: string, path: string): void {
		let f: string;
		try {
			f = readFileSync(path, "utf8");
		} catch (err) {
			throw newE201FromPosition(
				err instanceof Error ? err.message : String(err),
				path,
				1,
			);
		}

		if (!this.compiled.has(chkName)) this.addCheck(f, chkName, path);
	}

	private addCheck(file: string, chkName: string, path: string): void {
		const [rule, taggedPOS] = this.compileCheck(file, chkName, path);
		this.registerCheck(chkName, rule, taggedPOS);
	}

	/**
	 * Turns a rule's source into a `Rule`.
	 *
	 * It reads the configuration but does not touch the manager's own state;
	 * everything that writes to the manager is in `registerCheck`.
	 */
	compileCheck(file: string, chkName: string, path: string): [Rule, boolean] {
		let generic = parseDefinition(file, path);

		// An `extends` naming a rule rather than an extension point starts
		// from that rule's definition.
		generic = flatten(this.config, generic, path, []);

		// A named scope stands in for its expression, so it is replaced before
		// anything reads the scope: validation, the selector registry, and the
		// walker all see the expression the rule would have written.
		let scope: string[] | null;
		try {
			scope = expandScopes(generic.scope, this.config.scopes);
		} catch (err) {
			throw newE201FromTarget(
				err instanceof Error ? err.message : String(err),
				"scope",
				path,
			);
		}
		if (scope !== null) generic.scope = scope;

		generic.name = chkName;
		generic.path = path;

		// A level set for the rule wins; a level set for its style covers the
		// rest of that style, so `proselint = suggestion` can be written once
		// and `proselint.Typography = warning` kept alongside it.
		const own = this.config.ruleToLevel[chkName];
		const forStyle = this.config.ruleToLevel[styleName(chkName)];
		if (own !== undefined) generic.level = own;
		else if (forStyle !== undefined) generic.level = forStyle;
		else if (generic.level === undefined) generic.level = "warning";

		// Scalar overrides from the configuration -- `Std.SentenceLength[max] =
		// 30` -- land after inheritance and before the field reads, which
		// coerce the string and reject a parameter the rule does not have.
		for (const [param, val] of Object.entries(
			this.config.ruleToParams[chkName] ?? {},
		)) {
			generic[param] = paramValue(val);
		}

		if (generic.scope === null || generic.scope === undefined) {
			// Not for `sequence`, which needs to tell an unset scope from an
			// explicit `text` one: it runs on sentences, and has to know
			// whether the author asked for somewhere in particular to take them
			// from. Nor for the measuring checks, which default to the summary.
			const extendsValue = generic.extends;
			if (
				extendsValue !== "sequence" &&
				extendsValue !== "metric" &&
				extendsValue !== "readability"
			) {
				generic.scope = ["text"];
			}
		}

		const rule = buildRule(this.config, generic);

		const pos = generic.pos;
		return [rule, pos !== undefined && pos !== null && pos !== ""];
	}

	/** Records a compiled rule and what it implies for the run. */
	private registerCheck(chkName: string, rule: Rule, taggedPOS: boolean): void {
		for (const s of rule.fields().scope) {
			for (const base of scopeBases(s)) {
				this.scopes.add(base);
				const named = this.scopeRules.get(base);
				if (named === undefined) this.scopeRules.set(base, [chkName]);
				else if (!stringInSlice(chkName, named)) named.push(chkName);
			}
			for (const [id, sel] of docSelectorMap(s)) {
				if (this.docs.has(id)) continue;
				try {
					compileSelector(sel);
				} catch (err) {
					throw newE201FromTarget(
						`invalid selector in 'doc(...)': ${err instanceof Error ? err.message : String(err)}`,
						"scope",
						chkName,
					);
				}
				this.docs.set(id, sel);
			}
		}

		if (rule.fields().extends === "sequence" || taggedPOS) this.tagging = true;

		this.addRule(chkName, rule);
	}

	/**
	 * A built-in rule's definition with the configuration's settings applied:
	 * its level, and its scalar parameters, so that `Vale.Spelling[split] = YES`
	 * reaches the rule the way it reaches one loaded from a file.
	 */
	private defaultRule(name: string): BaseCheck {
		const generic = cloneRule(DEFAULT_RULES[name] ?? {});
		const full = `Vale.${name}`;
		const level = this.config.ruleToLevel[full];
		if (level !== undefined) generic.level = level;
		for (const [param, val] of Object.entries(
			this.config.ruleToParams[full] ?? {},
		)) {
			generic[param] = paramValue(val);
		}
		generic.path = "internal";
		return generic;
	}

	private loadDefaultRules(): void {
		if (!this.needsStyle("Vale")) return;

		for (const style of DEFAULT_STYLES) {
			if (stringInSlice(style, this.styles)) {
				throw new Error(`'${style}' collides with built-in style`);
			}
		}

		for (const name of ["Repetition", "Spelling"]) {
			this.compiled.set(
				`Vale.${name}`,
				buildRule(this.config, this.defaultRule(name)),
			);
		}

		this.loadVocabRules();
	}

	private loadStyles(styles: readonly string[]): void {
		const found: string[] = [];
		const need: string[] = [];

		for (const baseDir of this.config.searchPaths()) {
			for (const style of styles) {
				const p = joinPath(baseDir, style);
				if (this.hasStyle(style)) continue; // already loaded
				if (!isDir(p)) {
					need.push(style);
					continue;
				}
				this.addStyle(p);
				found.push(style);
			}
		}

		for (const s of need) {
			if (stringInSlice(s, found)) continue;
			let msg = `Style '${s}' isn't on the StylesPath (${this.config.searchPaths().join(", ")}).`;
			let pkgs: string[] = [];
			try {
				pkgs = getPackages(this.config.rootINI);
			} catch {
				pkgs = [];
			}
			if (pkgs.length > 0) msg += " If it's a package, run `vale sync`.";
			throw newE201FromKey(
				this.config.configFiles,
				"BasedOnStyles",
				(v) => v === s,
				msg,
			);
		}

		this.styles.push(...found);
	}

	private loadVocabRules(): void {
		this.addTerms("Vale.Terms", this.config.acceptedTokens);
		this.addAvoid("Vale.Avoid", this.config.rejectedTokens);

		// A vocabulary a section names gets rules of its own, which the
		// configuration turns on only for that section's files.
		for (const name of this.config.sectionVocabs()) {
			const vocab = this.config.vocabularies[name];
			if (vocab === undefined) continue;
			this.addTerms(`Vale.${name}.Terms`, vocab.accepted);
			this.addAvoid(`Vale.${name}.Avoid`, vocab.rejected);
		}
	}

	/**
	 * Adds a `Terms` rule, which reports an accepted term in the wrong case.
	 *
	 * Under the default word template each term gets its own boundaries: not
	 * preceded or followed by a word character. For a term that starts and ends
	 * with one that is `\b`; for `C++` or `.NET`, whose edges `\b` cannot match
	 * beside a space, it is what lets the term be found at all.
	 */
	private addTerms(name: string, terms: readonly string[]): void {
		if (terms.length === 0) return;

		const own = this.config.wordTemplate === "";
		const swap: Record<string, string> = {};
		for (const term of terms) {
			let pattern = termPattern(term.toLowerCase());
			if (own) pattern = `(?<!\\w)${pattern}(?!\\w)`;
			swap[pattern] = term;
		}

		const vocab = cloneRule(DEFAULT_RULES.Terms ?? {});
		vocab.name = name;
		vocab.swap = swap;
		if (own) vocab.nonword = true;
		const level = this.config.ruleToLevel[name];
		if (level !== undefined) vocab.level = level;

		let rule: Rule;
		try {
			rule = buildRule(this.config, vocab);
		} catch {
			// A term that cannot be compiled is not worth stopping the run for:
			// Go discards the error here too.
			return;
		}
		if (rule instanceof Substitution) rule.terms = true;
		this.compiled.set(name, rule);
	}

	/** Adds an `Avoid` rule, which reports a rejected term. */
	private addAvoid(name: string, terms: readonly string[]): void {
		if (terms.length === 0) return;

		const avoid = cloneRule(DEFAULT_RULES.Avoid ?? {});
		avoid.name = name;
		avoid.tokens = terms.map((t) => termPattern(t));
		const level = this.config.ruleToLevel[name];
		if (level !== undefined) avoid.level = level;

		try {
			this.compiled.set(name, buildRule(this.config, avoid));
		} catch {
			// As above.
		}
	}

	private hasStyle(name: string): boolean {
		return stringInSlice(name, this.styles) || stringInSlice(name, DEFAULT_STYLES);
	}

	/**
	 * Whether any part of the configuration could run the named rule,
	 * mirroring the linter's own test ahead of compiling.
	 */
	private enabledSomewhere(name: string): boolean {
		const cfg = this.config;
		const style = styleName(name);

		// Named on: decides wherever it is set, `BasedOnStyles` or not.
		for (const sec of Object.values(cfg.sChecks)) {
			const found = checkSetting(sec, name, style);
			if (found !== null && found) return true;
		}
		const global = checkSetting(cfg.gChecks, name, style);
		if (global !== null) return global;

		// Otherwise it runs where its style is based on, unless that same
		// section switches it off.
		if (stringInSlice(style, cfg.gBaseStyles)) return true;
		for (const [sec, styles] of Object.entries(cfg.sBaseStyles)) {
			if (!stringInSlice(style, styles)) continue;
			const found = checkSetting(cfg.sChecks[sec] ?? {}, name, style);
			if (found !== null && !found) continue;
			return true;
		}

		return false;
	}

	private needsStyle(name: string): boolean {
		const cfg = this.config;

		if (stringInSlice(name, cfg.gBaseStyles)) return true;

		for (const s of Object.keys(cfg.gChecks)) {
			if (s.startsWith(name)) return true;
		}

		for (const s of Object.values(cfg.sBaseStyles)) {
			if (stringInSlice(name, s)) return true;
		}

		for (const s of Object.values(cfg.sChecks)) {
			for (const chk of Object.keys(s)) {
				if (chk.startsWith(name)) return true;
			}
		}

		return false;
	}

	/** Resolves a rule reference to its file, for a caller inspecting one. */
	resolveRule(name: string): string {
		return resolveRule(this.config, name);
	}
}

/**
 * A rule's setting, falling back to its style's -- the precedence the linter
 * uses for the same question at lint time.
 */
function checkSetting(
	settings: Readonly<Record<string, boolean>>,
	rule: string,
	style: string,
): boolean | null {
	const own = settings[rule];
	if (own !== undefined) return own;
	const forStyle = settings[style];
	return forStyle === undefined ? null : forStyle;
}

/**
 * A scalar setting as the field reads read it.
 *
 * `YES` and `NO` are how the configuration spells a bool everywhere else, so
 * they are accepted for a bool parameter too; anything else passes as written.
 */
export function paramValue(val: string): string {
	switch (val.trim().toUpperCase()) {
		case "YES":
			return "true";
		case "NO":
			return "false";
		default:
			return val;
	}
}
