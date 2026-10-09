/**
 * Views: a named, virtual reading of part of a file's structured content.
 *
 * A data file is not prose, but parts of it are: an OpenAPI description, a
 * commit message's body, the docstrings in a Python module. A view says which
 * parts, as a set of queries, and gives each one a scope name so rules can be
 * aimed at it.
 *
 * Three engines answer those queries:
 *
 * - `dasel` queries the parsed value of a data file;
 * - `tree-sitter` queries the syntax tree of a source file;
 * - `textfsm` reads a plain-text file through a template -- a state machine of
 *   regular expressions -- and names what it captures.
 */

import { readFileSync } from "node:fs";
import { parse as parseYAML } from "yaml";
import { selectValues } from "./dasel.ts";
import { fileToValue, newScalarResolver, type ScalarPos } from "./structured.ts";
import { joinCaptures, parseTemplate, type Template } from "./textfsm.ts";
import { strLen } from "./util.ts";

const VIEW_ENGINES = ["tree-sitter", "dasel", "textfsm"];

/** One query to run against a document. */
export interface Scope {
	name: string;
	expr: string;
	/** The markup the selected text is written in, if any. */
	type: string;
	/**
	 * The separator a selected list of strings is joined with, so the list
	 * reads as one value rather than one value per element.
	 *
	 * A notebook cell's source is such a list.
	 */
	join?: string;
}

/**
 * One value a view found, with the source position it was parsed from.
 *
 * Line and column are 1-based; both are 0 when the format gives no position
 * information, or when the value could not be located in the parse tree.
 */
export interface ScopedValue {
	text: string;
	line: number;
	column: number;
	/**
	 * Whether the value was made from a list, so its own line breaks are real
	 * ones rather than an escape inside a scalar.
	 */
	joined?: boolean;
	/** How the value maps back to the scalars it was decoded from. */
	parts?: Part[];
}

/**
 * The run of a value that came from one scalar: where it starts in the value
 * and in the source, and the source text it was decoded from.
 */
export interface Part {
	/** The character offset within the value. */
	offset: number;
	line: number;
	column: number;
	/**
	 * The scalar's quote character, or "" for a plain or block scalar.
	 *
	 * A quoted scalar decodes escapes, so a column in its text is not a column
	 * in the source.
	 */
	quote: string;
	/**
	 * The source line from `column` on.
	 *
	 * The walk through its escapes stops there, so a quoted scalar folded over
	 * several lines is placed by its first.
	 */
	raw: string;
}

/** A value that has been assigned a scope. */
export interface ScopedValues {
	scope: string;
	format?: string;
	values: ScopedValue[];
}

/** What a view needs to know about the file it is reading. */
export interface ViewTarget {
	content: string;
	realExt: string;
}

/** Maps a character offset in a value to its line and column in the source. */
export function locateInValue(v: ScopedValue, off: number): [number, number] {
	const parts = v.parts;
	if (parts === undefined || parts.length === 0) {
		return [v.line, v.column + off];
	}

	let p = parts[0]!;
	for (const q of parts.slice(1)) {
		if (q.offset > off) break;
		p = q;
	}
	let d = Math.max(off - p.offset, 0);

	if (p.quote !== "") {
		return [p.line, p.column + rawWidth(p.raw, p.quote, d)];
	}

	// A plain or block scalar spans source lines as its text does, and every
	// line of a block starts at the indentation of its first.
	const text = [...v.text];
	if (p.offset + d > text.length) d = text.length - p.offset;
	const seg = text.slice(p.offset, p.offset + d).join("");
	const nl = seg.lastIndexOf("\n");
	if (nl >= 0) {
		const breaks = seg.split("\n").length - 1;
		return [p.line + breaks, p.column + strLen(seg.slice(nl + 1))];
	}
	return [p.line, p.column + d];
}

/**
 * How many characters of a quoted scalar's source text decode to its first `d`
 * characters.
 *
 * An escape is several characters in the source and one in the value; a doubled
 * quote in a single-quoted scalar is two and one.
 */
function rawWidth(raw: string, quote: string, d: number): number {
	const runes = [...raw];
	let i = 0;
	let decoded = 0;
	while (i < runes.length && decoded < d) {
		const r = runes[i]!;
		if (quote === "'" && r === "'") {
			if (runes[i + 1] === "'") i += 2;
			else return i; // the closing quote
		} else if (quote === '"' && r === '"') {
			return i;
		} else if (quote === '"' && r === "\\" && i + 1 < runes.length) {
			i += escapeWidth(runes[i + 1]!);
		} else {
			i++;
		}
		decoded++;
	}
	return i;
}

/** The width of an escape, counting the backslash before it. */
function escapeWidth(kind: string): number {
	switch (kind) {
		case "x":
			return 4;
		case "u":
			return 6;
		case "U":
			return 10;
		default:
			return 2;
	}
}

export class View {
	readonly engine: string;
	readonly scopes: Scope[];
	/** The TextFSM template a `textfsm` view reads with. */
	readonly template: string;

	private fsm: Template | null = null;

	constructor(init: {
		engine: string;
		scopes: Scope[];
		template?: string;
	}) {
		this.engine = init.engine;
		this.scopes = init.scopes;
		this.template = init.template ?? "";

		if (this.engine === "") throw new Error("missing parser");
		if (!VIEW_ENGINES.includes(this.engine)) {
			throw new Error(`unsupported parser: ${this.engine}`);
		}
		if (this.scopes.length === 0) throw new Error("missing queries");
		if (this.engine === "textfsm") this.compileTemplate();
	}

	/**
	 * Parses a `textfsm` view's template and checks that every scope names one
	 * of its values.
	 */
	private compileTemplate(): void {
		if (this.template.trim() === "") {
			throw new Error("a textfsm view needs a template");
		}

		let fsm: Template;
		try {
			fsm = parseTemplate(this.template);
		} catch (err) {
			throw new Error(
				`template: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		for (const s of this.scopes) {
			if (!fsm.values.some((v) => v.name === s.expr)) {
				throw new Error(`scope "${s.expr}" names no Value in the template`);
			}
		}

		this.fsm = fsm;
	}

	/** Runs the view over a file. */
	apply(f: ViewTarget): ScopedValues[] {
		if (this.engine === "textfsm") return this.applyTemplate(f);
		return this.applyData(f);
	}

	/**
	 * Runs a `textfsm` view over a file.
	 *
	 * A `List` value's captures on consecutive lines are joined into one value,
	 * so a body reads as the paragraphs it is rather than one block per line. A
	 * gap in the lines starts another value, and so does a change of column: a
	 * value is placed by one line and one column, so every line in it has to
	 * start where its first line does.
	 */
	private applyTemplate(f: ViewTarget): ScopedValues[] {
		if (this.fsm === null) throw new Error("the template was never compiled");
		const records = this.fsm.run(f.content);

		const found: ScopedValues[] = [];
		for (const s of this.scopes) {
			let values: ScopedValue[] = [];
			for (const rec of records) {
				values.push(...joinCaptures(rec[s.expr] ?? []));
			}
			if (values.length === 0) {
				// A value the template never filled is still a scope, so a rule
				// that requires something of it can report that it is missing.
				// Every other rule sees no text and stays quiet.
				values = [{ text: "", line: 1, column: 1 }];
			}
			found.push({ scope: s.name, values, format: s.type });
		}
		return found;
	}

	private applyData(f: ViewTarget): ScopedValues[] {
		const { value, scalars } = fileToValue(f);
		const resolver = newScalarResolver(scalars);
		const srcLines = f.content.split("\n");
		const part = (sp: ScalarPos, offset: number): Part =>
			newPart(srcLines, sp, offset);

		const found: ScopedValues[] = [];
		for (const s of this.scopes) {
			let items: unknown[];
			try {
				items = selectValues(value, s.expr);
			} catch (err) {
				throw new Error(
					`processing scope "${s.name}": ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const values: ScopedValue[] = [];
			for (const item of items) {
				if (typeof item === "string") {
					const sv: ScopedValue = { text: item, line: 0, column: 0 };
					const sp = resolver.locate(item);
					if (sp !== null) {
						sv.line = sp.line;
						sv.column = sp.column;
						sv.parts = [part(sp, 0)];
					}
					values.push(sv);
					continue;
				}

				if (Array.isArray(item)) {
					const parts = stringList(item);
					if (parts === null || s.join === undefined || parts.length === 0) {
						continue;
					}
					// Each element is placed on its own, so the list may be
					// written one per line or all on one; and each is consumed,
					// so a later scope is not placed on a line this value covers.
					const sv: ScopedValue = {
						text: parts.join(s.join),
						line: 0,
						column: 0,
						joined: true,
						parts: [],
					};
					let offset = 0;
					for (let i = 0; i < parts.length; i++) {
						const sp = resolver.locate(parts[i]!);
						if (sp !== null) {
							if (i === 0) {
								sv.line = sp.line;
								sv.column = sp.column;
							}
							sv.parts!.push(part(sp, offset));
						}
						offset += strLen(parts[i]!) + strLen(s.join);
					}
					if (sv.parts!.length > 0 && sv.parts![0]!.offset !== 0) {
						// The first element was not found; the value has no place
						// of its own, so it is searched for instead.
						sv.parts = undefined;
					}
					values.push(sv);
				}
			}

			found.push({ scope: s.name, values, format: s.type });
		}

		return found;
	}
}

/** Places one scalar's run of a value in the source. */
function newPart(srcLines: readonly string[], sp: ScalarPos, offset: number): Part {
	let raw = "";
	const line = srcLines[sp.line - 1];
	if (line !== undefined) {
		const runes = [...line];
		if (sp.column - 1 < runes.length) raw = runes.slice(sp.column - 1).join("");
	}
	return {
		offset,
		line: sp.line,
		column: sp.column,
		quote: sp.quote,
		raw,
	};
}

/** The list, when every element of it is a string. */
function stringList(list: readonly unknown[]): string[] | null {
	const parts: string[] = [];
	for (const v of list) {
		if (typeof v !== "string") return null;
		parts.push(v);
	}
	return parts;
}

/** Reads a view definition from a YAML file. */
export function newView(path: string): View {
	const data = readFileSync(path, "utf8");
	return parseView(data);
}

/** Reads a view definition from YAML text. */
export function parseView(data: string): View {
	const raw = parseYAML(data) as {
		engine?: string;
		template?: string;
		scopes?: Array<{ name?: string; expr?: string; type?: string; join?: string }>;
	} | null;

	if (raw === null || typeof raw !== "object") {
		throw new Error("missing parser");
	}

	const scopes: Scope[] = (raw.scopes ?? []).map((s) => ({
		name: s.name ?? "",
		expr: s.expr ?? "",
		type: s.type ?? "",
		...(s.join !== undefined ? { join: s.join } : {}),
	}));

	return new View({
		engine: raw.engine ?? "",
		scopes,
		template: raw.template ?? "",
	});
}
