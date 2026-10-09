/**
 * Reading a source file: its comments are the prose.
 *
 * tree-sitter finds the comments (see `code/`), and each one is linted in the
 * file's place -- as plain lines, or as the markup a view says it is written
 * in. The alerts are then moved back to where the comment sits in the source,
 * which is `fragment.ts`'s job.
 *
 * A comment that holds markup is linted as a *fragment* of that markup: a
 * fenced block in a Rust `///` comment is code, and a `<pre>` in a Javadoc
 * block is not prose. The file is a fragment of that format while the comment
 * is read, and itself again afterwards.
 */

import type { Alert, Block, Config, File, Scope } from "@vale-ts/core";
import {
	blankRunes,
	Block as CoreBlock,
	COMMENTS_BY_NORMED_EXT,
	sanitize,
	splitAfterLines,
} from "@vale-ts/core";
import { adjustAlerts } from "./fragment.ts";
import { lintQDocFragment } from "./qdoc.ts";
import { convertRSTBatch, lintRST, lintRSTHTML, prepareRST } from "./rst.ts";
import type { Comment, Language } from "./code/index.ts";
import { getComments, getLanguageFromExt, hasLanguage, masked } from "./code/index.ts";

/** What a source-file reader needs from the linter. */
export interface CodeHost {
	config: Config;
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
	lintMetadata(f: File): void;
	lintLines(f: File): void;
	lintBlock(
		f: File,
		blk: Block,
		lines: number,
		pad: number,
		lookup: boolean,
	): void;
	lintSummary(f: File): void;
	/** Reads the file as the named markup. */
	readAs(f: File, format: string): void;
}

/**
 * The queries a tree-sitter view puts in place of a language's own.
 *
 * A data view's selectors are not queries; it reads the file itself, and may
 * hand a cell of it here as code.
 */
export function updateQueries(f: File, cfg: Config): Scope[] {
	let found: Scope[] = [];

	for (const [syntax, view] of Object.entries(cfg.views)) {
		if (view.engine !== "tree-sitter") continue;
		if (cfg.sectionApplies(syntax, f.held, f.path)) found = view.scopes;
	}

	return found;
}

/**
 * Whether `IgnoredScopes` excludes a comment of this scope --
 * `text.comment.block` for a Python docstring, say.
 *
 * Both paths that read comments consult this. Which one runs depends on
 * whether a markup format is mapped onto the file, and asking for Markdown in
 * your comments must not also cost you the ability to exclude one. See #858.
 */
export function skipsComment(cfg: Config, scope: string): boolean {
	return (
		cfg.ignoredScopes.includes("comment") || cfg.ignoredScopes.includes(scope)
	);
}

/**
 * A URL in a comment, up to the punctuation that would close a sentence or a
 * bracket around it.
 */
const URL_RE =
	/\b(?:https?|ftp):\/\/[^\s<>"'`)\]]*[^\s<>"'`)\].,;:!?]/g;

/**
 * Blanks the URLs in a comment.
 *
 * A URL is never prose, and in markup the converter keeps one out of the text
 * already.
 */
export function maskURLs(s: string): string {
	return s.replace(URL_RE, blankRunes);
}

/** Reads a source file. */
export function lintCode(host: CodeHost, f: File): void {
	if (!hasLanguage(f.realExt)) {
		// No grammar and no delimiters for this file type.
		lintCodeOld(host, f);
		return;
	}

	// Throws when the grammars have not been loaded, which is the one thing
	// about this port that cannot be done on demand. See `code/lang.ts`.
	const lang = getLanguageFromExt(f.realExt);

	const found = updateQueries(f, host.config);
	if (found.length > 0) lang.queries = found;

	const comments = getComments(f.content, lang);
	const wholeFile = f.content;

	const converted = rstBatch(host, f, comments, "");

	// The file may hold alerts from cells before this one.
	let last = f.alerts.length;
	for (let i = 0; i < comments.length; i++) {
		const comment = comments[i];
		f.setMetaScope(comment.scope);
		if (skipsComment(host.config, comment.scope)) continue;

		lintComment(host, f, comment, comment.format, converted.get(i) ?? "");
		dropMasked(f.alerts, last, comment);

		const size = f.alerts.length;
		if (size !== last) adjustAlerts(f.alerts, last, comment, lang);
		last = size;
	}

	f.setText(wholeFile);
	if (f.summary.length > 0) {
		// The comments read as markup added up to a summary; see lintSizedScopes.
		host.lintSummary(f);
	}
}

/**
 * Converts every comment written in reStructuredText in one Docutils call, and
 * returns each one's HTML by index.
 *
 * `fallback` is the format a comment has when its query named none. Nothing is
 * returned when fewer than two comments qualify or the batch fails, and each
 * comment is then converted on its own.
 */
export function rstBatch(
	host: CodeHost,
	f: File,
	comments: readonly Comment[],
	fallback: string,
): Map<number, string> {
	const docs: string[] = [];
	const idx: number[] = [];

	// Each comment is prepared as the fragment it will be linted as; see
	// lintComment.
	const wholeFile = f.content;
	const kind = f.format;
	const ext = f.normedExt;
	f.format = "fragment";
	f.setNormedExt("rst");

	try {
		for (let i = 0; i < comments.length; i++) {
			const c = comments[i];
			const format = c.format === "" ? fallback : c.format;
			if (format !== "rst" || skipsComment(host.config, c.scope)) continue;

			f.setText(c.text);
			docs.push(prepareRST(host, f));
			idx.push(i);
		}
	} catch {
		return new Map();
	} finally {
		f.format = kind;
		f.normedExt = ext;
		f.setText(wholeFile);
	}

	if (docs.length < 2) return new Map();

	let parts: string[];
	try {
		parts = convertRSTBatch(host, docs);
	} catch {
		return new Map();
	}

	const out = new Map<number, string>();
	for (let k = 0; k < idx.length; k++) out.set(idx[k], parts[k]);
	return out;
}

/**
 * Removes the alerts, from `last` on, that the comment's documentation
 * convention masks: the symbol a tag names, the body of an example.
 *
 * The alerts are still placed within the comment's text, so this runs before
 * they are moved back into the source.
 */
export function dropMasked(
	alerts: Alert[],
	last: number,
	comment: Comment,
): void {
	if (comment.masks.length === 0) return;
	const kept = alerts
		.slice(last)
		.filter((a) => !masked(comment, a.line, a.span[0]));
	alerts.length = last;
	alerts.push(...kept);
}

/**
 * Lints one comment as the markup named -- `md`, `rst`, `html`, `org`, `adoc`
 * or `qdoc` -- or as plain lines when none is.
 *
 * `html` is the comment already converted, when it was part of a batch (see
 * `rstBatch`), and "" otherwise.
 */
export function lintComment(
	host: CodeHost,
	f: File,
	comment: Comment,
	format: string,
	html: string,
): void {
	if (format === "") {
		f.setText(maskURLs(comment.text));
		host.lintLines(f);
		return;
	}

	const kind = f.format;
	const ext = f.normedExt;
	f.format = "fragment";
	f.setNormedExt(format);
	f.setText(comment.text);

	try {
		switch (f.normedExt) {
			case ".md":
			case ".html":
			case ".adoc":
			case ".org":
				host.readAs(f, format);
				break;
			case ".rst":
				if (html !== "") lintRSTHTML(host, f, html);
				else lintRST(host, f);
				break;
			case ".qdoc":
				// A comment is a fragment: there is no `/*!` left to wait for.
				lintQDocFragment(host, f);
				break;
			default:
				throw new Error(`unsupported markup format '${format}'`);
		}
	} finally {
		f.format = kind;
		f.normedExt = ext;
	}
}

/**
 * Reads a source file by matching its comment delimiters, line by line.
 *
 * This is the last resort, for a file with neither a grammar nor delimiters
 * in `COMMENTS_BY_NORMED_EXT` -- in which case it finds nothing and returns.
 * The languages with no grammar are read by the scanner in `code/scanner.ts`,
 * which produces the same comments a query does and so reaches everything
 * this cannot: the markup a view maps onto a file, the dedent, the masks.
 */
export function lintCodeOld(host: CodeHost, f: File): void {
	const comments = COMMENTS_BY_NORMED_EXT[f.normedExt];
	if (comments === undefined) return;

	const ignored = host.config.ignoredScopes;
	const skipAll = ignored.includes("comment");
	const skipInline = ignored.includes("comment.line");
	const skipBlock = ignored.includes("comment.block");

	const inline = new RegExp(comments.inline);
	const blockStart = new RegExp(comments.blockStart);
	const blockEnd = new RegExp(comments.blockEnd);

	let block = "";
	let lines = 0;
	let ignore = false;
	let inBlock = false;

	for (const raw of splitAfterLines(f.content)) {
		if (raw === "") continue;
		const line = sanitize(raw.endsWith("\n") ? raw : `${raw}\n`);
		const lnLength = line.length;
		lines++;

		if (inBlock) {
			// Inside a block comment.
			if (blockEnd.test(line)) {
				block += line;
				const txt = maskURLs(block);
				const b = new CoreBlock(txt, txt, `text.comment.block${f.realExt}`);
				if (!skipAll && !skipBlock) {
					host.lintBlock(f, b, lines + 1, 0, true);
				}
				block = "";
				inBlock = false;
			} else {
				block += line;
			}
			continue;
		}

		const hit = inline.exec(line);
		if (hit !== null) {
			// An inline comment. The padding is what makes the column right:
			// `print("foo") # ...` is condensed to `# ...`.
			const padding = lnLength - hit[0].length;
			const match = maskURLs(hit[0]);
			const b = new CoreBlock(match, match, `text.comment.line${f.realExt}`);
			if (!skipAll && !skipInline) {
				host.lintBlock(f, b, lines, padding - 1, true);
			}
			continue;
		}

		if (blockStart.test(line) && !ignore) {
			block += line;
			inBlock = true;
			continue;
		}

		if (blockEnd.test(line)) ignore = !ignore;
	}
}

export type { Comment, Language };
