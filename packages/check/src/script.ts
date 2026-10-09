/**
 * `script`: a rule written as a Tengo program, which is handed the block's
 * text and hands back the spans it found.
 */

import { readFileSync } from "node:fs";
import {
	type Alert,
	type Block,
	type Config,
	type File,
	findConfigAsset,
	newE201FromTarget,
	SCRIPT_DIR,
} from "@vale-ts/core";
import { resolveFix } from "./action.ts";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	type Definition,
	formatMessages,
	type Rule,
	readDefinition,
	readStructureError,
} from "./definition.ts";
import { ruleError, TENGO_TIMEOUT_MS } from "./metric.ts";
import { type CompiledScript, isTimeout, tengo } from "./tengo.ts";

export class Script implements Rule {
	private readonly definition: Definition;

	/** `script` (`string`): the program, or the name of a `.tengo` file. */
	readonly script: string;

	/**
	 * The parsed program, built once with the rule.
	 *
	 * Compiling is the expensive part of running a script, and the source
	 * never changes; only the text handed to it does. Each block gets a clone,
	 * which copies the globals and leaves the program shared.
	 */
	private readonly compiled: CompiledScript;

	private readonly path: string;

	constructor(cfg: Config | null, generic: BaseCheck, path: string) {
		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.script = f.string("script");
			f.done();
		} catch (err) {
			throw readStructureError(err, path);
		}

		let source = this.script;
		if (source.endsWith(".tengo")) {
			const file = cfg === null ? "" : findConfigAsset(cfg, source, SCRIPT_DIR);
			try {
				source = readFileSync(file, "utf8");
			} catch (err) {
				throw newE201FromTarget(
					err instanceof Error ? err.message : String(err),
					this.script,
					path,
				);
			}
		}
		this.script = source;
		this.path = path;

		try {
			// The `os` module is deliberately left out: a rule is configuration
			// a project may have pulled in, not code its author vouched for.
			const program = tengo().Script.compile(source, {
				modules: ["text", "fmt", "math"],
			});
			// Declared now so the compiled program has a slot for it; the value
			// is replaced per block.
			program.add("scope", "");
			this.compiled = program;
		} catch (err) {
			throw newE201FromTarget(
				err instanceof Error ? err.message : String(err),
				"script",
				path,
			);
		}
	}

	run(blk: Block, _file: File | null, cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];

		// A clone per block: the program is shared and its globals are not.
		const compiled = this.compiled.clone();
		compiled.set("scope", blk.text);

		try {
			compiled.run({ timeoutMs: TENGO_TIMEOUT_MS });
		} catch (err) {
			throw ruleError(
				this.definition.name,
				"script",
				this.path,
				err,
				isTimeout(err),
			);
		}

		for (const match of parseMatches(compiled.get("matches"))) {
			const { begin, end } = match;
			const matchText = blk.text.slice(begin, end);
			const a: Alert = {
				action: {
					name: this.definition.action.name,
					params: [...this.definition.action.params],
				},
				suggestions: [],
				check: this.definition.name,
				severity: this.definition.level,
				span: [begin, end],
				link: this.definition.link,
				match: matchText,
				description: "",
				message: "",
				line: 0,
				hide: false,
			};

			// The script indexed the block; an alert's absolute span indexes the
			// document. A block that is its own document -- the raw scope, or a
			// plain-text file -- needs no translation, and one the runs never
			// mapped is left to the text search, which has the match to find.
			const src = sourceSpan(blk, begin, end);
			if (src !== null) {
				a.span = src;
				a.hasByteOffsets = true;
			}

			[a.message, a.description] = formatMessages(
				match.message ?? this.definition.message,
				this.definition.description,
				matchText,
			);

			resolveFix(a, cfg);
			alerts.push(a);
		}

		return alerts;
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return this.script;
	}
}

interface ScriptMatch {
	begin: number;
	end: number;
	message?: string;
}

/** Reads the `matches` a program left behind. */
export function parseMatches(value: unknown): ScriptMatch[] {
	if (!Array.isArray(value)) return [];

	const matches: ScriptMatch[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") continue;
		const m = item as Record<string, unknown>;
		const begin = asInt(m.begin);
		const end = asInt(m.end);
		if (begin === null || end === null) continue;

		const match: ScriptMatch = { begin, end };
		if (typeof m.message === "string") match.message = m.message;
		matches.push(match);
	}
	return matches;
}

function asInt(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
	if (typeof v === "bigint") return Number(v);
	return null;
}

/**
 * Carries a span of the block's text to the document, or null when the block
 * does not know where that text came from.
 */
export function sourceSpan(
	blk: Block,
	begin: number,
	end: number,
): [number, number] | null {
	if (begin < 0 || end < begin || end > blk.text.length) return null;
	if (blk.text === blk.context) return [begin, end];

	const src = blk.sourceOffset(begin);
	if (src < 0) return null;
	if (end === begin) return [src, src];

	const last = blk.sourceOffset(end - 1);
	if (last < src) return null;
	return [src, last + 1];
}
