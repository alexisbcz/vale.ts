/**
 * Linting a document's front matter.
 *
 * The block itself is not prose -- its keys are identifiers, its dates are
 * dates -- so the reader wraps the whole thing in a code block before
 * converting. The fields that *are* prose, a title or a description, are linted
 * here instead, each placed by where its value sits in the file.
 *
 * YAML and JSON are placed by the parser, which knows where each scalar is.
 * TOML has no such positions, so each value is found by searching for it.
 */

import type { ScopeMatcher } from "@vale-ts/check";
import type { Config, File, ScopedValues } from "@vale-ts/core";
import {
	Block,
	frontMatterValues,
	newE201FromPosition,
	parseFrontMatter,
} from "@vale-ts/core";
import { findBestLineBySubstring } from "./util.ts";

/** What linting front matter needs from the linter. */
export interface MetadataHost {
	config: Config;
	/** The scopes `IgnoredScopes` excludes. */
	ignoredScope(): ScopeMatcher;
	lintBlock(f: File, blk: Block, lines: number, pad: number, lookup: boolean): void;
	lintScopedValues(f: File, values: readonly ScopedValues[]): void;
}

/** Lints the prose fields of a document's front matter, if it has any. */
export function lintMetadata(host: MetadataHost, f: File): void {
	const fm = parseFrontMatter(f.content);
	if (fm === null) return;

	const ignored = host.ignoredScope();

	if (fm.kind !== "toml") {
		lintFrontMatterValues(host, f, fm.raw, ignored);
		return;
	}

	// TOML front matter is placed by searching for each value.
	for (const [key, value] of Object.entries(fm.data)) {
		if (typeof value !== "string") continue;
		const [i] = findBestLineBySubstring(fm.raw, value);
		if (i < 0) continue;

		const scope = `text.frontmatter.${key}${f.realExt}`;
		const block = new Block(f.content, value, scope, i - 1);
		if (ignored.matches(block)) continue;

		host.lintBlock(f, block, f.lines.length, 0, false);
	}
}

/**
 * Lints YAML or JSON front matter field by field, each placed by its scalar's
 * position rather than by a text search -- which found a value inside an
 * earlier field that shared its prefix.
 */
function lintFrontMatterValues(
	host: MetadataHost,
	f: File,
	fm: string,
	ignored: ScopeMatcher,
): void {
	let values: ScopedValues[];
	try {
		values = frontMatterValues(fm);
	} catch (err) {
		throw newE201FromPosition(
			err instanceof Error ? err.message : String(err),
			f.path,
			1,
		);
	}

	const kept = values.filter(
		(v) => !ignored.matches(new Block("", "", `text.${v.scope}${f.realExt}`)),
	);

	// The values are linted in the file's place; the body follows, so what they
	// change is put back.
	const normed = f.normedExt;
	const meta = f.metaScope;
	try {
		host.lintScopedValues(f, kept);
	} finally {
		f.normedExt = normed;
		f.metaScope = meta;
	}
}
