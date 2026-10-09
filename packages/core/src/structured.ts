/**
 * A data file read as a value, plus where each of its scalars was written.
 *
 * A view's selector runs against the decoded value -- a plain object, array or
 * string -- which carries no positions. An alert has to land on a line, so the
 * parse is walked a second time to collect every scalar in document order, and
 * the strings a selector returns are matched back against that list.
 *
 * # Positions
 *
 * A scalar is reported at its first *content* character, not at the token that
 * introduces it: past the opening quote of a quoted scalar, and down on the
 * first content line of a block scalar (`|`, `>`), whose indicator sits on the
 * line above. That is what makes `description: |` place an alert inside the
 * block rather than on the key.
 *
 * The `yaml` package reports a node's `range` as offsets into the source, so
 * those are converted; `node.type` stands in for what Go reads from
 * `node.Style`.
 */

import { parse as parseTOML } from "smol-toml";
import {
	type Document,
	isAlias,
	isMap,
	isScalar,
	isSeq,
	parseDocument,
	type Scalar,
	visit,
} from "yaml";
import { strLen } from "./util.ts";
import type { Part, ViewTarget } from "./view.ts";
import { fatalYAMLErrors, LENIENT } from "./yaml.ts";

/**
 * One scalar value's source position, and the quote it was written with.
 *
 * Line and column are 1-based; the quote is `""` for a plain or block scalar.
 */
export interface ScalarPos {
	value: string;
	line: number;
	column: number;
	quote: string;
}

/** Hands out scalars by value, each once, in document order. */
export interface ScalarResolver {
	/**
	 * The first unconsumed scalar with this value, or null -- in which case a
	 * caller has to fall back to a textual search.
	 */
	locate(value: string): ScalarPos | null;
}

/** A source text indexed by line, so an offset can be given a position. */
export interface Source {
	lines: string[];
	/** The offset each line starts at. */
	starts: number[];
}

/** Indexes a source text by line. */
export function newSource(src: string): Source {
	const starts = [0];
	for (let i = 0; i < src.length; i++) {
		if (src[i] === "\n") starts.push(i + 1);
	}
	return { lines: src.split("\n"), starts };
}

/** The 1-based line and column an offset falls on. */
export function positionAt(src: Source, offset: number): [number, number] {
	let lo = 0;
	let hi = src.starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (src.starts[mid]! <= offset) lo = mid;
		else hi = mid - 1;
	}
	const start = src.starts[lo]!;
	return [lo + 1, strLen(src.lines[lo]!.slice(0, offset - start)) + 1];
}

/**
 * Decodes a data file into a value, and collects the positions of its
 * scalars.
 *
 * JSON is a strict YAML subset, so it is decoded as JSON -- which is what
 * dasel navigates -- and then reparsed as YAML for positions. TOML has no
 * position information at all, so its scalars are left empty and a value from
 * it is placed by a textual search instead.
 */
export function fileToValue(f: ViewTarget): {
	value: unknown;
	scalars: ScalarPos[];
} {
	let value: unknown;
	let scalars: ScalarPos[] = [];

	switch (f.realExt) {
		case ".json": {
			value = JSON.parse(f.content);
			const doc = parseDocument(f.content, LENIENT);
			if (fatalYAMLErrors(doc).length === 0) {
				scalars = walkYAMLScalars(doc, newSource(f.content));
			}
			break;
		}
		case ".toml":
			value = parseTOML(f.content);
			break;
		default: {
			// YAML, which reads JSON too, for `.yml`, `.yaml`, and anything the
			// section matched that is not named for its format.
			//
			// Folded `>` indicators are rewritten to literal `|` so the parsed
			// value keeps its newlines: mapping a position back into the source
			// then works line for line instead of having to guess where the
			// folds happened. The parser itself locates the indicators, so the
			// rewrite is precise.
			const rewritten = foldedToLiteral(f.content);
			const doc = parseDocument(rewritten, LENIENT);
			const bad = fatalYAMLErrors(doc);
			if (bad.length > 0) throw yamlError(bad);
			value = doc.toJS();
			scalars = walkYAMLScalars(doc, newSource(rewritten));
		}
	}

	if (value === null || value === undefined) {
		throw new Error("document root is empty");
	}
	return { value, scalars };
}

/**
 * Flattens a parsed document into a document-ordered list of its scalars.
 *
 * Mapping keys are skipped: only the values are included, which is what a
 * selector returns.
 */
export function walkYAMLScalars(doc: Document, src: Source): ScalarPos[] {
	const out: ScalarPos[] = [];
	const open = new Set<unknown>();

	const walk = (node: unknown): void => {
		if (node === null || node === undefined) return;
		if (isMap(node)) {
			for (const item of node.items) walk(item.value);
			return;
		}
		if (isSeq(node)) {
			for (const item of node.items) walk(item);
			return;
		}
		if (isScalar(node)) {
			out.push(scalarAt(node, src));
			return;
		}
		if (isAlias(node)) {
			// An alias reads as the node it names, so its scalars are listed
			// again -- at the anchor's position, which is where they were
			// written. `open` is what stops a recursive anchor.
			const target = node.resolve(doc);
			if (target !== undefined && !open.has(target)) {
				open.add(target);
				walk(target);
				open.delete(target);
			}
		}
	};

	walk(doc.contents);
	return out;
}

/** Records where a scalar's content starts. */
export function scalarAt(node: Scalar, src: Source): ScalarPos {
	const [markerLine, markerCol] = positionAt(src, node.range?.[0] ?? 0);
	let line = markerLine;
	let column = markerCol;
	let quote = "";

	switch (node.type) {
		case "BLOCK_LITERAL":
		case "BLOCK_FOLDED":
			[line, column] = blockScalarContentStart(src.lines, markerLine);
			break;
		case "QUOTE_DOUBLE":
			// Step past the opening quote so callers point at the first
			// content character.
			column = markerCol + 1;
			quote = '"';
			break;
		case "QUOTE_SINGLE":
			column = markerCol + 1;
			quote = "'";
			break;
		default:
			break;
	}

	return { value: scalarText(node), line, column, quote };
}

/**
 * A scalar's text as the source wrote it.
 *
 * A selector returns decoded values, so a string's text is the decoded one;
 * but a number or a boolean is matched as it was written, which is what Go's
 * `node.Value` holds.
 */
export function scalarText(node: Scalar): string {
	if (typeof node.value === "string") return node.value;
	if (typeof node.source === "string") return node.source;
	return node.value === null || node.value === undefined ? "" : String(node.value);
}

/**
 * The 1-based line and column of the first non-blank content line of a block
 * scalar whose indicator is on `markerLine`.
 *
 * Falls back to the line after the indicator when there is no content line --
 * an empty block.
 */
export function blockScalarContentStart(
	lines: readonly string[],
	markerLine: number,
): [number, number] {
	for (let idx = markerLine; idx < lines.length; idx++) {
		const line = lines[idx]!;
		let trim = 0;
		while (trim < line.length && (line[trim] === " " || line[trim] === "\t")) {
			trim++;
		}
		if (trim === line.length) continue;
		return [idx + 1, trim + 1];
	}
	return [markerLine + 1, 1];
}

/**
 * Rewrites every folded (`>`) block indicator to a literal (`|`) one, so a
 * later parse keeps the newlines in the value.
 *
 * The source comes back unchanged when it holds no folded scalar. A `>` inside
 * a string is left alone, because the parse -- not a search -- is what finds
 * the indicators.
 */
export function foldedToLiteral(src: string): string {
	const doc = parseDocument(src, LENIENT);
	const bad = fatalYAMLErrors(doc);
	if (bad.length > 0) throw yamlError(bad);

	const hits: number[] = [];
	visit(doc, {
		Scalar(_key, node) {
			if (node.type === "BLOCK_FOLDED" && node.range != null) {
				hits.push(node.range[0]);
			}
		},
	});
	if (hits.length === 0) return src;

	const out = [...src];
	for (const at of hits) {
		if (at >= 0 && at < out.length && out[at] === ">") out[at] = "|";
	}
	return out.join("");
}

/**
 * Indexes the scalars by value, so that placing every value in a large
 * document is linear rather than quadratic.
 */
export function newScalarResolver(scalars: ScalarPos[]): ScalarResolver {
	const byValue = new Map<string, ScalarPos[]>();
	for (const s of scalars) {
		const queue = byValue.get(s.value);
		if (queue === undefined) byValue.set(s.value, [s]);
		else queue.push(s);
	}
	const taken = new Map<string, number>();

	return {
		locate(value: string): ScalarPos | null {
			const queue = byValue.get(value);
			if (queue === undefined) return null;
			const at = taken.get(value) ?? 0;
			if (at >= queue.length) return null;
			taken.set(value, at + 1);
			return queue[at]!;
		},
	};
}

/** Places one scalar's run of a value in the source. */
export function newPart(
	srcLines: readonly string[],
	sp: ScalarPos,
	offset: number,
): Part {
	let raw = "";
	const line = srcLines[sp.line - 1];
	if (line !== undefined) {
		const runes = [...line];
		if (sp.column - 1 < runes.length) {
			raw = runes.slice(sp.column - 1).join("");
		}
	}
	return {
		offset,
		line: sp.line,
		column: sp.column,
		quote: sp.quote,
		raw,
	};
}

/** The first parse error, as the one error a caller sees. */
function yamlError(errors: ReadonlyArray<{ message: string }>): Error {
	const first = errors[0];
	return new Error(first === undefined ? "invalid YAML" : first.message);
}
