/**
 * Front matter: the metadata block at the top of a document.
 *
 * Two things read it. A conditional section -- `[*.md if .Meta.draft]` --
 * needs its values to decide whether it applies, and the `frontmatter.<key>`
 * scopes need them placed in the file so a rule can report on one.
 */

import { parse as parseTOML } from "smol-toml";
import { type Document, isMap, isScalar, parseDocument, type Scalar } from "yaml";
import { blockScalarContentStart } from "./structured.ts";
import { parseLenientDocument, YAMLError } from "./yaml.ts";

/** The delimiters a front-matter block may be wrapped in. */
const DELIMITERS: Array<[string, string, "yaml" | "toml" | "json"]> = [
	["---", "---", "yaml"],
	["+++", "+++", "toml"],
	[";;;", ";;;", "json"],
];

export interface FrontMatter {
	/** The block as the file holds it, delimiters included. */
	raw: string;
	/** The parsed values, or an empty object when they could not be read. */
	data: Record<string, unknown>;
	/** Everything after the block. */
	body: string;
	/** Which syntax the block was written in. */
	kind: "yaml" | "toml" | "json";
}

/**
 * Reads the front matter at the top of `content`, or null when there is none.
 *
 * A block has to start on the first line: a `---` further down is a thematic
 * break, not metadata.
 */
export function parseFrontMatter(content: string): FrontMatter | null {
	for (const [open, close, kind] of DELIMITERS) {
		if (!content.startsWith(`${open}\n`) && content.trimEnd() !== open) continue;

		const end = content.indexOf(`\n${close}`, open.length);
		if (end < 0) continue;

		const inner = content.slice(open.length + 1, end);
		const afterDelimiter = end + 1 + close.length;
		const body = content.slice(afterDelimiter).replace(/^\r?\n/, "");

		return {
			raw: content.slice(0, afterDelimiter),
			data: parseBlock(inner, kind),
			body,
			kind,
		};
	}

	// A JSON object standing on its own, which is the other form
	// `adrg/frontmatter` accepts.
	if (content.startsWith("{")) {
		const end = matchingBrace(content);
		if (end > 0) {
			const inner = content.slice(0, end + 1);
			try {
				const data = JSON.parse(inner) as Record<string, unknown>;
				return {
					raw: inner,
					data,
					body: content.slice(end + 1).replace(/^\r?\n/, ""),
					kind: "json",
				};
			} catch {
				return null;
			}
		}
	}

	return null;
}

function parseBlock(
	inner: string,
	kind: "yaml" | "toml" | "json",
): Record<string, unknown> {
	try {
		switch (kind) {
			case "yaml": {
				const doc = parseDocument(inner);
				const value = doc.toJS();
				return value !== null && typeof value === "object"
					? (value as Record<string, unknown>)
					: {};
			}
			case "toml":
				return parseTOML(inner) as Record<string, unknown>;
			case "json":
				return JSON.parse(inner) as Record<string, unknown>;
		}
	} catch {
		// Metadata Vale cannot read is metadata a condition sees as absent,
		// which is better than refusing to lint the file.
		return {};
	}
}

function matchingBrace(s: string): number {
	let depth = 0;
	let inString = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i;
	}
	return -1;
}

/** One value a view or front-matter reader found, and where it sits. */
export interface ScopedValue {
	/** The text to check. */
	text: string;
	/** The 1-based line it starts on. */
	line: number;
	/** The 1-based column it starts at. */
	column: number;
}

/** The values one scope holds. */
export interface ScopedValues {
	scope: string;
	values: ScopedValue[];
}

/**
 * Each top-level string field of YAML or JSON front matter, in document
 * order, scoped `frontmatter.<key>`.
 *
 * `fm` is the block as the file holds it, starting at the file's first line,
 * so the positions reported are the file's.
 */
/**
 * A front-matter parse error, worded as `yaml.Unmarshal` words it.
 *
 * `yaml.v3` names the line in the message itself, and the message is what the
 * person reading the error sees. Two things move the line:
 *
 * - A truncated block's error sits at the end of the input, which this parser
 *   places on the empty line after the last one written; `yaml.v3` names the
 *   last line that has content.
 * - Go is given the block's inner text, where this is given the block with its
 *   delimiters blanked -- which is what keeps a *value's* line right. So the
 *   opening delimiter's line comes back off here.
 */
function frontMatterError(err: YAMLError, lines: readonly string[]): string {
	let line = err.line;
	while (line > 1 && (lines[line - 1] ?? "").trim() === "") line--;
	return `yaml: line ${Math.max(line - 1, 1)}: ${err.message}`;
}

export function frontMatterValues(fm: string): ScopedValues[] {
	// The delimiter lines are blanked rather than cut, so the lines keep their
	// numbers.
	const lines = fm.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i]!.trim();
		if (t === "---" || t === ";;;") lines[i] = "";
	}

	// Read as leniently as Vale reads any other YAML, and no more: front
	// matter Vale could not parse is a document Vale could not read, which the
	// caller reports rather than linting the body anyway.
	let doc: Document.Parsed;
	try {
		doc = parseLenientDocument(lines.join("\n"));
	} catch (err) {
		if (err instanceof YAMLError) throw new Error(frontMatterError(err, lines));
		throw err;
	}

	const root = doc.contents;
	if (!isMap(root)) return [];

	const source = lines.join("\n");
	const found: ScopedValues[] = [];
	for (const item of root.items) {
		const value = item.value;
		if (!isScalar(value) || typeof value.value !== "string") continue;
		if (isTimestamp(value)) continue;
		const key = isScalar(item.key) ? String(item.key.value) : null;
		if (key === null) continue;

		const range = value.range;
		const at = range ? range[0] : 0;
		found.push({
			scope: `frontmatter.${key}`,
			values: [{ text: value.value, ...contentStart(source, lines, value, at) }],
		});
	}
	return found;
}

/**
 * Where a scalar's *content* starts, which is not where its token starts.
 *
 * A quoted scalar's position has to step past the opening quote and a block
 * scalar's has to step down onto its first content line, or an alert on
 * `title: "Some text"` lands on the quote rather than on the text. This is
 * what `scalarAt` does for a view's values, and front matter is placed the
 * same way.
 */
function contentStart(
	source: string,
	lines: readonly string[],
	node: Scalar,
	at: number,
): { line: number; column: number } {
	const marker = positionOf(source, at);
	switch (node.type) {
		case "BLOCK_LITERAL":
		case "BLOCK_FOLDED": {
			const [line, column] = blockScalarContentStart(lines, marker.line);
			return { line, column };
		}
		case "QUOTE_DOUBLE":
		case "QUOTE_SINGLE":
			return { line: marker.line, column: marker.column + 1 };
		default:
			return marker;
	}
}

/**
 * The shapes `yaml.v3` resolves as `!!timestamp` rather than `!!str`.
 *
 * Go keeps only a field whose tag is `!!str`, so a `date: 2024-01-01` is left
 * out -- it is metadata, not prose, and nothing should report on it. The
 * JavaScript parser has no timestamp type in its default schema and hands back
 * a plain string, so the shapes are recognized here instead.
 */
const TIMESTAMP =
	/^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ]\d{1,2}:\d{1,2}:\d{1,2}(?:\.\d+)?[ \t]*(?:Z|[-+]\d{1,2}(?::?\d{2})?)?)?$/;

function isTimestamp(node: Scalar): boolean {
	// Only a plain scalar resolves to a tag; quoting one says it is a string.
	if (node.type !== undefined && node.type !== "PLAIN") return false;
	return TIMESTAMP.test(String(node.value));
}

/** The 1-based line and column of an offset into `source`. */
export function positionOf(
	source: string,
	offset: number,
): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < offset && i < source.length; i++) {
		if (source[i] === "\n") {
			line++;
			lineStart = i + 1;
		}
	}
	return { line, column: offset - lineStart + 1 };
}
