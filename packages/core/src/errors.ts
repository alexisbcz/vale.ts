/**
 * Vale's own failures, as distinct from findings in a document.
 *
 * `E100` is something that went wrong at runtime; `E201` is an invalid value
 * in a configuration file or a rule. The parts are kept apart and formatted
 * only when shown, so the JSON and line outputs can read the fields rather
 * than parsing a rendered message back apart.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { stripANSI } from "./util.ts";

/** One line of the excerpt shown above an error's message. */
export interface ExcerptLine {
	number: number;
	text: string;
	/** Whether this is the line the error is about. */
	marked: boolean;
}

export class ValeError extends Error {
	/** `E100` or `E201`. */
	readonly code: "E100" | "E201";

	/**
	 * Where an `E100` came from: a command, or the file being linted. An
	 * `E201` has a position instead.
	 */
	readonly context: string;

	/** The file holding the invalid value. */
	readonly path: string;
	/** 1-based; 0 when the value could not be placed. */
	readonly line: number;
	/** The 1-based column of the value. */
	readonly span: number;

	/** The lines around `line`, shown above the message. */
	readonly excerpt: ExcerptLine[];

	/** The message itself, without the banner around it. */
	readonly msg: string;

	constructor(init: {
		code: "E100" | "E201";
		context?: string;
		path?: string;
		line?: number;
		span?: number;
		excerpt?: ExcerptLine[];
		msg: string;
	}) {
		super(init.msg);
		this.name = "ValeError";
		this.code = init.code;
		this.context = init.context ?? "";
		this.path = init.path ?? "";
		this.line = init.line ?? 0;
		this.span = init.span ?? 0;
		this.excerpt = init.excerpt ?? [];
		this.msg = init.msg;
	}

	/** The title shown above the message. */
	title(): string {
		if (this.code === "E100") return `[${this.context}] Runtime error`;
		return `Invalid value [${toSlash(this.path)}:${this.line}:${this.span}]:`;
	}
}

function toSlash(p: string): string {
	return p.replaceAll("\\", "/");
}

/**
 * Wraps something that went wrong at runtime, naming where it came from.
 *
 * An error that is already Vale's own passes through unchanged, so it is never
 * shown as one banner nested inside another.
 */
export function newE100(context: string, err: unknown): ValeError {
	if (err instanceof ValeError) return err;
	const msg = err instanceof Error ? err.message : String(err);
	return new ValeError({ code: "E100", context, msg });
}

/** Whether a line is the one an error should point at. */
export type ErrorCondition = (
	position: number,
	line: string,
	target: string,
) => boolean;

interface Placed {
	line: number;
	span: number;
	excerpt: ExcerptLine[];
}

/**
 * Finds the first line `finder` accepts and returns it with up to two lines
 * either side. A value that is not found has no line and no excerpt.
 */
function annotate(file: string, target: string, finder: ErrorCondition): Placed {
	const all: ExcerptLine[] = [];
	const at: Placed = { line: 0, span: 1, excerpt: [] };

	const lines = file.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const idx = i + 1;
		if (at.line !== 0 && idx - at.line > 2) break;
		const text = stripANSI(lines[i]!);
		const marked = at.line === 0 && finder(idx, text, target);
		if (marked) {
			at.line = idx;
			if (target !== "") at.span = text.indexOf(target) + 1;
		}
		all.push({ number: idx, text, marked });
	}

	if (at.line === 0) return at;

	for (const l of all) {
		if (at.line - l.number < 3) at.excerpt.push(l);
	}
	return at;
}

/**
 * An error about an invalid value in the file at `target`, placed at the first
 * line `finder` accepts.
 */
export function newE201(
	msg: string,
	value: string,
	target: string,
	finder: ErrorCondition,
): ValeError {
	let content: string;
	try {
		content = readFileSync(target, "utf8");
	} catch {
		return newE100(path.basename(target), new Error(msg));
	}

	const at = annotate(content, value, finder);
	return new ValeError({
		code: "E201",
		path: target,
		line: at.line,
		span: at.span,
		excerpt: at.excerpt,
		msg,
	});
}

/** An `E201` at the first line containing `value`. */
export function newE201FromTarget(
	msg: string,
	value: string,
	file: string,
): ValeError {
	return newE201(msg, value, file, (_, line, t) => line.includes(t));
}

/** An `E201` at a given line. */
export function newE201FromPosition(
	msg: string,
	file: string,
	goal: number,
): ValeError {
	return newE201(msg, "", file, (position) => position === goal);
}

/**
 * An `E201` at the line of a configuration file that sets `key` to a value
 * `match` accepts, searched across every file the run loaded.
 *
 * Falls back to an `E100` when none of them does, which happens when the value
 * was computed rather than written.
 */
export function newE201FromKey(
	configFiles: readonly string[],
	key: string,
	match: (value: string) => boolean,
	msg: string,
): ValeError {
	// The value that matched, so the column points at it.
	let hit = "";
	const names: ErrorCondition = (_, line) => {
		const eq = line.indexOf("=");
		if (eq < 0) return false;
		if (line.slice(0, eq).trim() !== key) return false;
		for (const raw of line.slice(eq + 1).split(",")) {
			const item = raw.trim();
			if (match(item)) {
				hit = item;
				return true;
			}
		}
		return false;
	};

	for (const p of configFiles) {
		let content: string;
		try {
			content = readFileSync(p, "utf8");
		} catch {
			continue;
		}
		const at = annotate(content, "", names);
		if (at.line !== 0) return newE201(msg, hit, p, names);
	}

	return newE100(key, new Error(msg));
}

/** Where warnings go, so a caller can collect them instead of printing. */
export type WarnSink = (msg: string) => void;

let sink: WarnSink = (msg) => {
	// Warnings go to stderr to stay clear of `--output=JSON` and the other
	// formats a caller parses, which are written to stdout.
	process.stderr.write(`W101 ${msg}\n`);
};

/** Redirects warnings, and returns the previous sink. */
export function setWarnSink(next: WarnSink): WarnSink {
	const prev = sink;
	sink = next;
	return prev;
}

/**
 * Reports something the user should know about that does not stop the run --
 * an unrecognized key, say.
 */
export function warn(msg: string): void {
	sink(msg);
}
