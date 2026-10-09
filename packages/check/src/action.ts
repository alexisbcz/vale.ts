/**
 * Resolving an alert's action to the text it suggests.
 *
 * A rule says what to do about a finding -- `replace`, `remove`, `edit`,
 * `convert`, `suggest` -- and the alert carries that recipe. Turning it into
 * the answer happens here, so that output formats and editors see suggestions
 * rather than instructions.
 */

import { readFileSync } from "node:fs";
import {
	ACTION_DIR,
	type Action,
	type Alert,
	type Config,
	findAsset,
	findConfigAsset,
	newAlert,
} from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";
import type { BaseCheck } from "./decode.ts";
import type { Rule } from "./definition.ts";
import {
	capitalize,
	dumbPunctuation,
	expandGroups,
	numberToWords,
	smartPunctuation,
	squeeze,
	toASCII,
	uncapitalize,
	wordsToNumber,
} from "./editops.ts";
import { Manager } from "./manager.ts";
import { Spelling } from "./spelling.ts";
import * as strcase from "./strcase.ts";
import { type Compiled, tengo } from "./tengo.ts";
import { trimCutset, trimLeftCutset, trimRightCutset } from "./util.ts";

/** A potential solution to an alert. */
export interface Solution {
	suggestions: string[];
	error: string;
}

type Fixer = (alert: Alert, cfg: Config | null) => string[];

const FIXERS: Record<string, Fixer> = {
	suggest,
	replace,
	remove,
	convert,
	edit,
};

/**
 * How many parameters each `edit` operation takes, counting the operation's
 * own name.
 *
 * A flat parameter list is read as a pipeline by consuming that many at a
 * time, so the shape of `params` never changes.
 */
const EDIT_ARITY: Record<string, number> = {
	replace: 3,
	remove: 2,
	regex: 3,
	trim_right: 2,
	trim_left: 2,
	trim: 2,
	truncate: 2,
	split: 3,
	wrap: 2,
	unwrap: 2,
	prefix: 2,
	suffix: 2,
	squeeze: 1,
	capitalize: 1,
	uncapitalize: 1,
	smart: 1,
	dumb: 1,
	ascii: 1,
	words: 1,
	digits: 1,
	lower: 1,
	upper: 1,
	title: 1,
	sentence: 1,
	simple: 1,
	kebab: 1,
	snake: 1,
	camel: 1,
	pascal: 1,
};

let titleCase: strcase.TitleConverter | null = null;
let sentenceCase: strcase.SentenceConverter | null = null;

/** The converters, built on first use: each one loads the tagger. */
function titleConverter(): strcase.TitleConverter {
	if (titleCase === null) titleCase = new strcase.TitleConverter(strcase.apStyle);
	return titleCase;
}

function sentenceConverter(): strcase.SentenceConverter {
	if (sentenceCase === null) sentenceCase = new strcase.SentenceConverter();
	return sentenceCase;
}

/** Each `suggest` script compiled once; a run clones it. */
const scripts = new Map<string, { clone(): Compiled }>();

/** Forgets the compiled `suggest` scripts. Meant for tests. */
export function clearScriptCache(): void {
	scripts.clear();
}

/** Whether a script has been compiled from `file`. */
export function hasCompiledScript(file: string): boolean {
	return scripts.has(file);
}

/** The suggestions for an alert handed back as JSON. */
export function parseAlert(s: string, cfg: Config | null): Solution {
	const body = readAlert(s);
	const resp: Solution = { suggestions: [], error: "" };

	try {
		resp.suggestions = fixAlert(body, cfg);
	} catch (err) {
		resp.error = err instanceof Error ? err.message : String(err);
		resp.suggestions = [];
	}

	return resp;
}

/**
 * Reads an alert out of JSON.
 *
 * Go unmarshals into `core.Alert`, whose fields are capitalized, and an editor
 * hands back whatever Vale printed. Both spellings are accepted so that a
 * document produced by either side round-trips.
 */
function readAlert(s: string): Alert {
	const raw = JSON.parse(s) as Record<string, unknown>;
	const pick = (lower: string, upper: string): unknown =>
		raw[lower] !== undefined ? raw[lower] : raw[upper];

	const action = (pick("action", "Action") ?? {}) as Record<string, unknown>;
	const name = (action.name ?? action.Name ?? "") as string;
	const params = (action.params ?? action.Params ?? []) as string[];

	return newAlert({
		action: { name, params: [...params] },
		check: (pick("check", "Check") ?? "") as string,
		match: (pick("match", "Match") ?? "") as string,
		groups: (pick("groups", "Groups") ?? undefined) as string[] | undefined,
		message: (pick("message", "Message") ?? "") as string,
		severity: (pick("severity", "Severity") ?? "") as string,
		span: (pick("span", "Span") ?? [0, 0]) as number[],
		line: (pick("line", "Line") ?? 0) as number,
	});
}

/** Resolves the alert's action to its suggestions. */
export function fixAlert(alert: Alert, cfg: Config | null): string[] {
	const action = alert.action.name;
	const f = FIXERS[action];
	if (f !== undefined) return f(alert, cfg);
	throw new Error(`unknown action '${action}'`);
}

/**
 * Fills in the suggestions an alert's action produces, so that output carries
 * the answer rather than the recipe.
 */
export function resolveFix(a: Alert, cfg: Config | null): void {
	if (a.action.name === "") return;

	try {
		a.suggestions = fixAlert(a, cfg);
	} catch (err) {
		throw new Error(
			`${a.check}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Reports what is wrong with a rule's action before any alert depends on it:
 * an unknown name, the wrong number of parameters, or a script that is not on
 * disk.
 *
 * A bad action would otherwise surface as a lint-time error, once the rule had
 * already fired, with no file or line to point at.
 */
export function checkAction(cfg: Config | null, rule: Rule): void {
	const info = rule.fields();
	const action = info.action;
	const params = action.params;

	switch (action.name) {
		case "":
		case "replace":
		case "remove":
			return;
		case "suggest": {
			// A spelling rule's bare `suggest` has always meant its dictionaries.
			if (rule instanceof Spelling && params.length === 0) return;
			if (params.length !== 1) {
				throw new Error("'suggest' takes one parameter");
			}
			if (
				params[0] !== "spellings" &&
				scriptPath(cfg, params[0]!, info.name) === ""
			) {
				throw new Error(`script '${params[0]}' not found`);
			}
			return;
		}
		case "convert":
			if (params.length !== 1 || params[0] !== "simple") {
				throw new Error("'convert' takes one parameter: simple");
			}
			return;
		case "edit": {
			for (const step of editSteps(params)) {
				if (step[0] === "regex") Regexp.compile(step[1]!);
				else if (step[0] === "split" && !isInteger(step[2]!)) {
					throw new Error(`'split' index '${step[2]}' is not a number`);
				}
			}
			return;
		}
		default:
			throw new Error(`unknown action '${action.name}'`);
	}
}

function isInteger(s: string): boolean {
	return /^[+-]?\d+$/.test(s);
}

function suggest(alert: Alert, cfg: Config | null): string[] {
	const name = alert.action.params[0] ?? "spellings";

	if (name === "spellings") return spellingSuggestions(alert, cfg);
	return runScript(name, alert, cfg);
}

/**
 * Finds a `suggest` script under `config/actions`, then in the style's own
 * directory.
 */
function scriptPath(cfg: Config | null, name: string, check: string): string {
	if (cfg === null) return "";
	let file = findConfigAsset(cfg, name, ACTION_DIR);
	if (file === "") {
		const dot = check.indexOf(".");
		if (dot > 0) {
			file = findAsset(cfg, `${check.slice(0, dot)}/${name}`);
		}
	}
	return file;
}

function runScript(name: string, alert: Alert, cfg: Config | null): string[] {
	const file = scriptPath(cfg, name, alert.check);
	if (file === "") throw new Error(`script '${name}' not found`);

	const compiled = compileAction(file);

	const run = compiled.clone();
	run.set("match", alert.match);
	run.run();

	const out: string[] = [];
	const found = run.get("suggestions");
	if (Array.isArray(found)) {
		for (const s of found) {
			if (typeof s === "string") out.push(s);
		}
	}
	return out;
}

function compileAction(file: string): { clone(): Compiled } {
	const cached = scripts.get(file);
	if (cached !== undefined) return cached;

	const source = readFileSync(file, "utf8");

	const script = tengo().Script.compile(source, {
		modules: ["text", "fmt", "math"],
	});
	script.add("match", "");

	scripts.set(file, script);
	return script;
}

/**
 * The dictionaries' suggestions for a misspelling.
 *
 * The alert names its rule, which is the only thing that knows which
 * dictionaries to ask, so the rule is loaded again -- an editor asking for a
 * fix has only the alert.
 */
function spellingSuggestions(alert: Alert, cfg: Config | null): string[] {
	if (cfg === null) throw new Error(`unknown check '${alert.check}'`);

	const name = alert.check.split(".");
	if (name.length !== 2) throw new Error(`unknown check '${alert.check}'`);
	const path = `${cfg.stylesPath()}/${name[0]}/${name[1]}.yml`;

	const mgr = Manager.create(cfg);
	if (!mgr.rules().has(alert.check)) mgr.addRuleFromFile(alert.check, path);

	const rule = mgr.rules().get(alert.check);
	if (!(rule instanceof Spelling)) {
		throw new Error(`unknown check '${alert.check}'`);
	}

	return rule.suggestFor(alert.match, cfg);
}

function replace(alert: Alert, _cfg: Config | null): string[] {
	return alert.action.params.map((p) => expandGroups(p, alert.match, alert.groups));
}

function remove(_alert: Alert, _cfg: Config | null): string[] {
	return [""];
}

function convert(alert: Alert, _cfg: Config | null): string[] {
	const mode = alert.action.params[0];
	if (mode === undefined) throw new Error("no parameters");
	if (mode === "simple") return [strcase.simple(alert.match)];
	throw new Error(`unknown conversion '${mode}'`);
}

/**
 * Reads a flat parameter list as a sequence of operations, each taking as many
 * parameters as its arity says.
 */
export function editSteps(params: readonly string[]): string[][] {
	const steps: string[][] = [];

	for (let i = 0; i < params.length; ) {
		const name = params[i]!;
		const want = EDIT_ARITY[name];
		if (want === undefined) throw new Error(`unknown edit '${name}'`);
		if (i + want > params.length) {
			throw new Error(`'${name}' takes ${want - 1} parameter(s)`);
		}
		steps.push(params.slice(i, i + want));
		i += want;
	}

	if (steps.length === 0) throw new Error("'edit' needs an operation");
	return steps;
}

/**
 * Turns a nested `params` list, one list per operation, into the flat list the
 * action carries. A flat list passes through untouched.
 */
export function flattenAction(generic: BaseCheck): void {
	const action = generic.action;
	if (action === null || typeof action !== "object" || Array.isArray(action)) {
		return;
	}
	const params = (action as Record<string, unknown>).params;
	if (!Array.isArray(params)) return;

	const flat: unknown[] = [];
	let nested = false;
	for (const p of params) {
		if (Array.isArray(p)) {
			flat.push(...p);
			nested = true;
		} else flat.push(p);
	}
	if (nested) (action as Record<string, unknown>).params = flat;
}

function edit(alert: Alert, _cfg: Config | null): string[] {
	const steps = editSteps(alert.action.params);

	let match = alert.match;
	for (const step of steps) {
		// A regex step's `$1` means its own pattern's group, not the token's.
		const filled =
			step[0] === "regex"
				? step
				: step.map((arg, i) =>
						i === 0 ? arg : expandGroups(arg, alert.match, alert.groups),
					);
		match = editStep(match, filled);
	}

	return [match.trim()];
}

function editStep(match: string, step: readonly string[]): string {
	switch (step[0]) {
		case "replace":
			return match.replaceAll(step[1]!, step[2]!);
		case "remove": {
			let out = "";
			for (const r of match) {
				if (!step[1]!.includes(r)) out += r;
			}
			return out;
		}
		case "regex":
			// The same engine the rule's own patterns run on, so a lookaround
			// that found the match can also rewrite it.
			return Regexp.compile(step[1]!).replace(match, step[2]!, -1, -1);
		case "trim_right":
			return trimRightCutset(match, step[1]!);
		case "trim_left":
			return trimLeftCutset(match, step[1]!);
		case "trim":
			return trimCutset(match, step[1]!);
		case "truncate":
			return match.split(step[1]!)[0]!;
		case "split": {
			const index = Number.parseInt(step[2]!, 10);
			if (!Number.isFinite(index)) {
				throw new Error(`'split' index '${step[2]}' is not a number`);
			}
			const parts = match.split(step[1]!);
			if (index >= parts.length) throw new Error("index out of range");
			return parts[index]!;
		}
		case "wrap":
			return step[1]! + match + step[1]!;
		case "unwrap": {
			let out = match;
			if (out.startsWith(step[1]!)) out = out.slice(step[1]!.length);
			if (out.endsWith(step[1]!)) out = out.slice(0, -step[1]!.length);
			return out;
		}
		case "prefix":
			return step[1]! + match;
		case "suffix":
			return match + step[1]!;
		case "squeeze":
			return squeeze(match);
		case "capitalize":
			return capitalize(match);
		case "uncapitalize":
			return uncapitalize(match);
		case "smart":
			return smartPunctuation(match);
		case "dumb":
			return dumbPunctuation(match);
		case "ascii":
			return toASCII(match);
		case "words":
			return numberToWords(match);
		case "digits":
			return wordsToNumber(match);
		case "lower":
			return match.toLowerCase();
		case "upper":
			return match.toUpperCase();
		case "title":
			return titleConverter().convert(match);
		case "sentence":
			return sentenceConverter().convert(match);
		case "simple":
			return strcase.simple(match);
		case "kebab":
			return strcase.dash(match);
		case "snake":
			return strcase.snake(match);
		case "camel":
			return strcase.camel(match);
		case "pascal":
			return strcase.pascal(match);
		default:
			throw new Error(`unknown edit '${step[0]}'`);
	}
}

export type { Action };
