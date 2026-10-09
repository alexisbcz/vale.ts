/**
 * Collecting a source file's comments.
 *
 * Each query runs, each capture becomes a comment, and the comments are then
 * coalesced: a run of consecutive line comments at the same column is one
 * comment, because that is what the author wrote -- a paragraph, with a `//`
 * in front of each line. Reading them separately means a sentence spanning two
 * lines is never seen whole.
 *
 * What is left after that is dropped or masked: a shebang is a path, a
 * directive is addressed to a tool, and a documentation convention's tags name
 * symbols. See `doc.ts`.
 */

import { type Language as Grammar, Parser, Query } from "web-tree-sitter";
import { leadingMask } from "./doc.ts";
import { QueryEngine } from "./query.ts";
import { scanComments } from "./scanner.ts";
import type { Comment, Language } from "./types.ts";

/** Whether to *stop* concatenating line-scoped comments. */
function doneMerging(curr: Comment, prev: Comment): boolean {
	// Not on consecutive lines, not at the same column, or two queries with
	// different markup: each is read on its own.
	return (
		prev.line !== curr.line - 1 ||
		prev.offset !== curr.offset ||
		prev.format !== curr.format
	);
}

/**
 * Adds one line to a pending run of line comments.
 *
 * One newline per line, so the run ends up with exactly as many lines as the
 * source it came from. A blank line comment -- `//` with nothing after it --
 * is empty and contributes only its newline; giving it two ended that line
 * twice and put a line in the extracted text that the source does not have.
 * See #1022.
 *
 * The space after the delimiter belongs to the delimiter, and the padding
 * added when an alert is mapped back already counts it. Trimming only the
 * lines that still needed a newline left it on the ones that did not --
 * Rust's `///`, whose node content carries its own -- where it was then
 * counted twice. The first line of a run is trimmed by the caller.
 */
export function appendLine(lineArg: string): string {
	const line = lineArg.replace(/^ +/, "");
	return `${line.replace(/\n+$/, "")}\n`;
}

/**
 * Joins a pending run of lines to the text it belongs to.
 *
 * The run needs the line above it terminated, which is a question about that
 * text and not about the run: a comment whose node content already carried its
 * newline -- Rust's `//!`, for one -- is terminated, and adding another puts a
 * blank line between the two that the source does not have. Keying this off
 * the run instead lost the terminator whenever the run began with a blank
 * comment line, which cost a line in the other direction.
 */
export function attachRun(text: string, run: string): string {
	return (text.endsWith("\n") ? text : `${text}\n`) + run;
}

/** Merges each run of consecutive line comments into one comment. */
export function coalesce(comments: readonly Comment[]): Comment[] {
	const joined: Comment[] = [];

	let tBuf = "";
	let sBuf = "";

	/**
	 * Merges any pending line-comment text into the most recently appended
	 * comment, which is always the one this run of lines belongs to.
	 */
	const flush = (): void => {
		if (tBuf === "") return;
		const last = joined[joined.length - 1];
		last.text = attachRun(last.text, tBuf);
		last.source = attachRun(last.source, sBuf);
		tBuf = "";
		sBuf = "";
	};

	for (let i = 0; i < comments.length; i++) {
		const comment = comments[i];
		if (comment.scope === "text.comment.block") {
			// Flush first: a pending run of line comments belongs to the
			// preceding line comment, not this block. Without this, the buffered
			// text leaks into the block and is reported at the block's line
			// (past the end of the file) under the wrong scope. See #1020.
			flush();
			joined.push({ ...comment });
		} else if (i === 0 || doneMerging(comment, comments[i - 1])) {
			flush();
			joined.push({ ...comment });
		} else {
			tBuf += appendLine(comment.text);
			sBuf += appendLine(comment.source);
			// The declaration follows the run's last line, so its name belongs
			// to the run.
			if (comment.doc !== "") joined[joined.length - 1].doc = comment.doc;
		}
	}

	flush();

	for (const comment of joined) {
		const trimmed = comment.text.replace(/^ +/, "");

		// Trimming the first line moves it, so what came off it grows to match.
		// A block comment's first line is empty and this is a no-op.
		const n = comment.text.length - trimmed.length;
		if (n > 0 && comment.strip.length > 0) comment.strip[0] += n;

		comment.text = trimmed;
	}

	return joined;
}

/**
 * Each query compiled once per grammar; compiling is most of what a query
 * costs, and a notebook asks for the same one once per cell.
 *
 * Keyed by the grammar itself, not by its name: several languages share a
 * query -- `(comment) @comment` is most of them -- and a query compiled
 * against one grammar matches nothing when it is run over another's tree.
 * `initCode` loads each grammar once, so the identity is stable for the
 * process.
 */
const compiled = new WeakMap<Grammar, Map<string, Query>>();

function compiledQuery(lang: Language, expr: string): Query {
	const grammar = lang.grammar;
	if (grammar === null) throw new Error("no grammar for this language");

	let forGrammar = compiled.get(grammar);
	if (forGrammar === undefined) {
		forGrammar = new Map();
		compiled.set(grammar, forGrammar);
	}

	const hit = forGrammar.get(expr);
	if (hit !== undefined) return hit;

	const query = new Query(grammar, expr);
	forGrammar.set(expr, query);
	return query;
}

/** Every comment in `source`, in the order they appear. */
export function getComments(source: string, lang: Language): Comment[] {
	let comments: Comment[];

	if (lang.scanner !== null) {
		comments = scanComments(source, lang);
	} else {
		const parser = new Parser();
		parser.setLanguage(lang.grammar);
		const tree = parser.parse(source);
		if (tree === null) throw new Error("the source could not be parsed");

		const engine = new QueryEngine(tree, lang);
		comments = [];
		for (const query of lang.queries) {
			comments.push(
				...engine.run(query.name, query.type, compiledQuery(lang, query.expr)),
			);
		}

		if (lang.queries.length > 1) {
			comments.sort((a, b) => a.line - b.line);
		}

		// The tree and the parser are left to the collector. Freeing the parser
		// here took the WebAssembly module's parse entry point with it, and the
		// next file to be read could not be parsed at all.
	}

	const joined = coalesce(
		dropDirectives(dropShebang(dropVerbatim(comments, lang, source)), lang),
	);
	for (const c of joined) {
		if (lang.doc !== null) c.masks = lang.doc(c.text);
		const lead = leadingMask(c.text, c.doc);
		if (lead !== null) c.masks.push(lead);
	}

	return joined;
}

/**
 * Removes the comments that fall inside a literal the grammar is older than.
 *
 * See `Language.verbatim`. This runs before the comments are coalesced, so a
 * dropped one cannot join the run above it.
 */
function dropVerbatim(
	comments: readonly Comment[],
	lang: Language,
	source: string,
): Comment[] {
	const verbatim = lang.verbatim;
	if (verbatim === null) return [...comments];

	const spans = [...source.matchAll(verbatim)].map(
		(m) => [m.index, m.index + m[0].length] as const,
	);
	if (spans.length === 0) return [...comments];

	const starts = [0];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "\n") starts.push(i + 1);
	}

	return comments.filter((c) => {
		const at = (starts[c.line - 1] ?? 0) + c.offset;
		return !spans.some(([from, to]) => at >= from && at < to);
	});
}

/** Removes the comments addressed to a tool rather than a reader. */
function dropDirectives(comments: readonly Comment[], lang: Language): Comment[] {
	const directive = lang.directive;
	if (directive === null) return [...comments];
	return comments.filter((c) => !directive.test(c.source));
}

/**
 * Removes a leading `#!` line.
 *
 * A shebang names the interpreter a script runs under. Languages that use `#`
 * for comments give tree-sitter no way to tell the two apart, so it arrives
 * here as a comment and is linted as prose -- a path like `/usr/bin/env` then
 * draws alerts about words the author never wrote. See #631.
 *
 * Only the very first line of the file qualifies, which is also all the kernel
 * accepts, so a `#!` written anywhere else stays a comment.
 */
function dropShebang(comments: readonly Comment[]): Comment[] {
	for (let i = 0; i < comments.length; i++) {
		const c = comments[i];
		if (c.line !== 1 || c.offset !== 0) continue;
		if (!c.source.startsWith("#!")) continue;
		return [...comments.slice(0, i), ...comments.slice(i + 1)];
	}
	return [...comments];
}
