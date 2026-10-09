/**
 * Reading YAML as leniently as Vale does.
 *
 * Rules, vocabularies, views and notebooks are all YAML, and the files people
 * have written are read by `yaml.v3`, which accepts two things the
 * specification does not and this port's parser rejects by default:
 *
 * - **A duplicate key.** `yaml.v3` decoding into a map lets the last one win.
 *   One of the styles in Vale's own test corpus has a repeated term, and the
 *   style loads.
 * - **An unrecognized escape in a double-quoted scalar.** `\'` is not a YAML
 *   escape -- the quote needs none inside double quotes -- but `yaml.v3` reads
 *   it as the quote and moves on, and a rule in Vale's corpus is written that
 *   way.
 *
 * Refusing either would mean a style that works under Vale fails here, which is
 * the one outcome a port cannot have. So both are allowed, and everything else
 * is still an error: a file this cannot read is one `yaml.v3` could not read.
 */

import { parseDocument } from "yaml";
import type { Document } from "yaml";

/**
 * The errors `yaml.v3` accepts and this parser does not.
 *
 * Kept to exactly these two. A general "ignore the errors" would turn a
 * truncated file into an empty rule, which is how a style silently stops
 * running.
 */
const TOLERATED = new Set(["DUPLICATE_KEY", "BAD_DQ_ESCAPE"]);

/** Where a YAML error is, as a 1-based line and column. */
export interface YAMLErrorPosition {
	line: number;
	column: number;
	message: string;
}

export class YAMLError extends Error {
	readonly line: number;
	readonly column: number;
	/** The parser's own wording, before it was translated. */
	readonly detail: string;

	constructor(at: YAMLErrorPosition, detail = at.message) {
		super(at.message);
		this.name = "YAMLError";
		this.line = at.line;
		this.column = at.column;
		this.detail = detail;
	}
}

/**
 * How `yaml.v3` words the errors this parser words differently.
 *
 * An error message is read by a person, and the person reading it is following
 * Vale's documentation -- so the wording is part of what this port has to
 * reproduce, the same way a rule's message is. Only the mistakes a real
 * configuration makes are here; anything else keeps this parser's wording,
 * which is usually the more precise of the two.
 *
 * Matched on the error's code first and the start of its message second,
 * because one code covers several mistakes that `yaml.v3` reports differently.
 */
const GO_WORDING: Array<[string, string, string]> = [
	[
		"BLOCK_AS_IMPLICIT_KEY",
		"",
		"mapping values are not allowed in this context",
	],
	[
		"BAD_INDENT",
		"Flow sequence in block collection",
		"did not find expected node content",
	],
	["MISSING_CHAR", "Flow map must end with", "did not find expected node content"],
	["MISSING_CHAR", "Flow sequence must end with", "did not find expected node content"],
	["BAD_SCALAR_START", "", "did not find expected node content"],
	["MULTILINE_IMPLICIT_KEY", "", "could not find expected ':'"],
	["MISSING_CHAR", "Unexpected", "did not find expected key"],
];

/** The message `yaml.v3` would give for this error. */
export function goWording(code: string, message: string): string {
	const stated = message.split(" at line")[0] ?? message;
	for (const [wantCode, prefix, wording] of GO_WORDING) {
		if (code === wantCode && stated.startsWith(prefix)) return wording;
	}
	return stated;
}

/**
 * Parses YAML into a document, tolerating what Vale tolerates.
 *
 * Throws a `YAMLError` carrying the position of the first error it will not
 * accept, so a caller can report it as an `E201` at that line.
 */
export function parseLenientDocument(src: string): Document.Parsed {
	const doc = parseDocument(src, { uniqueKeys: false, keepSourceTokens: true });

	const fatal = doc.errors.filter((e) => !TOLERATED.has(e.code));
	if (fatal.length > 0) {
		const first = fatal[0]!;
		const [line, column] = positionOfOffset(src, first.pos[0]);
		throw new YAMLError(
			{ line, column, message: goWording(first.code, first.message) },
			first.message,
		);
	}

	return doc;
}

/**
 * The message Vale prints for a YAML file it could not read.
 *
 * `yaml.v3` prefixes its own errors with the line, and Vale passes that
 * through, so a notebook or a vocabulary that will not parse is reported in
 * exactly this shape.
 */
export function yamlErrorText(err: YAMLError): string {
	return `yaml: line ${err.line}: ${err.message}`;
}

/** Parses YAML into a plain value, tolerating what Vale tolerates. */
export function parseLenient(src: string): unknown {
	return parseLenientDocument(src).toJS();
}

/**
 * Parses YAML into a plain value, or returns null when it cannot be read.
 *
 * For the places Vale itself shrugs: a `.yml` file that is not a rule is not an
 * error, it is just not a rule.
 */
export function tryParseLenient(src: string): unknown | null {
	try {
		return parseLenient(src);
	} catch {
		return null;
	}
}

/** The 1-based line and column of an offset into `src`. */
export function positionOfOffset(
	src: string,
	offset: number,
): [number, number] {
	let line = 1;
	let start = 0;
	for (let i = 0; i < offset && i < src.length; i++) {
		if (src[i] === "\n") {
			line++;
			start = i + 1;
		}
	}
	return [line, offset - start + 1];
}
