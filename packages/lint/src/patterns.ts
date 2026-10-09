/**
 * The rewrites a configuration asks for before a document is read.
 *
 * `BlockIgnores` and `TokenIgnores` name patterns whose matches should not be
 * linted. Rather than filtering alerts afterwards -- which would need the
 * positions to survive a round trip -- the match is wrapped in the format's own
 * code delimiters, so the reader skips it for the same reason it skips any
 * other code. `CommentDelimiters` does the reverse: it rewrites a format's own
 * comment syntax into HTML comments, so Vale's directives work there.
 */

import type { Config } from "@vale-ts/core";
import { indent, newE201FromTarget } from "@vale-ts/core";
import { Regexp } from "@vale-ts/regex";

/** What a section needs to know about a file to decide whether it applies. */
export interface ExtensionConfig {
	/** The format the file is read as, which selects the parser and delimiters. */
	normed: string;
	/** Its extension on disk. */
	real: string;
	/** Its path. */
	realPath: string;
	/** The conditional sections whose `if` held for it. */
	held: Record<string, boolean>;
}

const FRONT_MATTER = /^(?:---|\+\+\+)\n([\s\S]+?)\n(?:---|\+\+\+)/;

/**
 * Whether a configuration section applies to this file.
 *
 * Sections are keyed on the file as it is on disk -- `[*.qmd]`, never `[*.md]`
 * by way of `[formats] qmd = md` -- which is how `BasedOnStyles` matches, and
 * the two have to agree: patterns that ignored text no rule was going to reach
 * would be pointless, and the reverse silently lints what the section says to
 * skip.
 *
 * The path is matched as well as the extension. Without it a section keyed on
 * one -- `[docs/*.md]` -- could never match, and its patterns were read,
 * compiled and then silently never applied.
 */
export function sectionMatches(
	exts: ExtensionConfig,
	cfg: Config,
	sec: string,
): boolean {
	return cfg.sectionApplies(sec, exts.held, exts.real, exts.realPath);
}

/**
 * How each format spells a block of code.
 *
 * A `BlockIgnores` match is wrapped in this. HTML has no source-level
 * delimiter, so a match is wrapped in the element the others convert to.
 */
export const BLOCK_DELIMITERS: Record<string, string> = {
	".adoc": "\n----\n$1\n----\n",
	".dita": "<codeblock>$1</codeblock>",
	".html": "<pre>$1</pre>",
	".md": "\n```\n$1\n```\n",
	".mdx": "\n```\n$1\n```\n",
	".myst": "\n```\n$1\n```\n",
	".qdoc": "\n\\code\n$1\n\\endcode\n",
	".qmd": "\n```\n$1\n```\n",
	".rst": "\n::\n\n%s\n",
	".typ": "\n```\n$1\n```\n",
	".org": "\n#+BEGIN_EXAMPLE\n$1\n#+END_EXAMPLE\n",
};

/** How each format spells inline code. */
export const INLINE_DELIMITERS: Record<string, string> = {
	".adoc": "`$1`",
	".dita": "<codeph>$1</codeph>",
	".html": "<code>$1</code>",
	".md": "`$1`",
	".mdx": "`$1`",
	".myst": "`$1`",
	".qdoc": "\\c {$1}",
	".qmd": "`$1`",
	".rst": "``$1``",
	".typ": "`$1`",
	".org": "=$1=",
};

function applyBlockPatterns(
	cfg: Config,
	exts: ExtensionConfig,
	content: string,
): string {
	const block = BLOCK_DELIMITERS[exts.normed];
	if (block === undefined) {
		throw new Error(`ignore patterns are not supported in '${exts.normed}' files`);
	}

	// The front matter is wrapped too, so its keys are not read as prose. The
	// values that *are* prose are linted separately, by `lintMetadata`.
	let s = content.replace(FRONT_MATTER, block);

	for (const [syntax, regexes] of Object.entries(cfg.blockIgnores)) {
		if (!sectionMatches(exts, cfg, syntax)) continue;
		for (const r of regexes) {
			let pat: Regexp;
			try {
				pat = Regexp.compile(r);
			} catch (err) {
				throw newE201FromTarget(
					err instanceof Error ? err.message : String(err),
					r,
					cfg.flags.path,
				);
			}

			if (exts.normed.endsWith(".rst")) {
				// A literal block needs its content indented under the `::`.
				for (const m of pat.findAllStringSubmatch(s, -1)) {
					const sec = block.replace("%s", indent(m[0]!, "    "));
					s = s.replace(m[0]!, sec);
				}
			} else {
				s = pat.replace(s, block, 0, -1);
			}
		}
	}

	return s;
}

function applyInlinePatterns(
	cfg: Config,
	exts: ExtensionConfig,
	content: string,
): string {
	const inline = INLINE_DELIMITERS[exts.normed];
	if (inline === undefined) {
		throw new Error(`ignore patterns are not supported in '${exts.normed}' files`);
	}

	let s = content;
	for (const [syntax, regexes] of Object.entries(cfg.tokenIgnores)) {
		if (!sectionMatches(exts, cfg, syntax)) continue;
		for (const r of regexes) {
			let pat: Regexp;
			try {
				pat = Regexp.compile(r);
			} catch (err) {
				throw newE201FromTarget(
					err instanceof Error ? err.message : String(err),
					r,
					cfg.flags.path,
				);
			}
			s = pat.replace(s, inline, 0, -1);
		}
	}
	return s;
}

/**
 * Replaces a format's own comment delimiters with HTML comment tags, so that
 * Vale's comment directives work in a format it does not otherwise read
 * comments from.
 */
function applyCommentPatterns(
	cfg: Config,
	exts: ExtensionConfig,
	content: string,
): string {
	let s = content;
	for (const [syntax, delims] of Object.entries(cfg.commentDelimiters)) {
		if (!sectionMatches(exts, cfg, syntax)) continue;
		if (delims[0] === "" && delims[1] === "") return s;
		if ((delims[0] === "") !== (delims[1] === "")) {
			throw new Error("CommentDelimiters must be empty or have two values");
		}
		s = s.replaceAll(delims[0], "<!--").replaceAll(delims[1], "-->");
	}
	return s;
}

/** Applies every rewrite the configuration asks for, in order. */
export function applyPatterns(
	cfg: Config,
	exts: ExtensionConfig,
	content: string,
): string {
	let s = applyBlockPatterns(cfg, exts, content);
	s = applyInlinePatterns(cfg, exts, s);
	return applyCommentPatterns(cfg, exts, s);
}

/**
 * Whether the configuration asks for any rewrite at all.
 *
 * A format with no delimiters -- plain text, a notebook -- can still be linted,
 * as long as nothing asks for a rewrite it cannot express.
 */
export function hasPatterns(cfg: Config, exts: ExtensionConfig): boolean {
	for (const syntax of Object.keys(cfg.blockIgnores)) {
		if (sectionMatches(exts, cfg, syntax)) return true;
	}
	for (const syntax of Object.keys(cfg.tokenIgnores)) {
		if (sectionMatches(exts, cfg, syntax)) return true;
	}
	for (const syntax of Object.keys(cfg.commentDelimiters)) {
		if (sectionMatches(exts, cfg, syntax)) return true;
	}
	return false;
}
