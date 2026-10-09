/**
 * Reading AsciiDoc, through Asciidoctor.
 *
 * Asciidoctor converts the document and the walker reads the HTML. What is
 * specific to AsciiDoc is what happens on either side: smart quotes are
 * normalized both ways, so a rule written with an apostrophe still matches
 * what the converter produced, and the source is rewritten afterwards so that
 * a match cannot be located inside a block attribute or a line comment --
 * neither of which survives into the HTML.
 *
 * The generated artifacts are switched off on the command line, which
 * overrides whatever the document itself asks for. Section numbers prefix a
 * heading with "N.", a table of contents duplicates every heading, and a
 * caption label writes "Table 1." in front of a block title: none of it is
 * authored prose, and all of it breaks heading detection and position lookup.
 * See #1101 and #1152.
 */

import type { Config, File } from "@vale-ts/core";
import { newE100, strLen, which } from "@vale-ts/core";
import { executeWithInput } from "./external.ts";

/** What an AsciiDoc reader needs from the linter. */
export interface ADocHost {
	config: Config;
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
	lintMetadata(f: File): void;
}

/**
 * Asciidoctor turns `'` into `’`, so both forms are normalized to the same
 * entity -- in the source before conversion and in the HTML after it.
 *
 * See #206.
 */
const SANITIZE: ReadonlyArray<readonly [string, string]> = [
	["‘", "&apos;"],
	["’", "&apos;"],
	["“", "&#8220;"],
	["”", "&#8221;"],
	["&#8217;", "&apos;"],
	["&rsquo;", "&apos;"],
];

function sanitize(s: string): string {
	let out = s;
	for (const [from, to] of SANITIZE) out = out.replaceAll(from, to);
	return out;
}

/** A listing block's attributes: `[source,ruby]`. */
const RE_SOURCE = /\[source,.+\]/g;
/** A line comment. */
const RE_COMMENT = /\/\/ .+/g;

const ADOC_ARGS = [
	"-s",
	"-a",
	"notitle!",
	"-a",
	"attribute-missing=drop",
	"-a",
	"sectnums!",
	"-a",
	"toc!",
	"-a",
	"table-caption!",
	"-a",
	"figure-caption!",
	"-a",
	"example-caption!",
	"-a",
	"listing-caption!",
];

/** The `[asciidoctor]` section as repeated `-a` flags. */
export function parseAttributes(attrs: Readonly<Record<string, string>>): string[] {
	const args: string[] = [];
	for (const [k, v] of Object.entries(attrs)) {
		let entry = `${k}=${v}`;
		if (v === "YES") entry = k;
		else if (v === "NO") entry = `${k}!`;
		args.push("-a", entry);
	}
	return args;
}

/** Reads an AsciiDoc file. */
export function lintADoc(host: ADocHost, f: File): void {
	const exe = which(["asciidoctor"]);
	if (exe === "") {
		throw newE100(
			f.path,
			new Error("asciidoctor not found; it's needed to read AsciiDoc"),
		);
	}

	host.lintMetadata(f);

	const source = sanitize(host.transform(f));

	let html: string;
	try {
		html = executeWithInput(exe, source, [
			...ADOC_ARGS,
			...parseAttributes(host.config.asciidoctor),
			"--safe-mode",
			"secure",
			"-",
		]);
	} catch (err) {
		throw newE100(f.path, err);
	}

	f.content = prepADoc(f.content);
	host.lintHTMLTokens(f, sanitize(html), 0);
}

/**
 * Masks the parts of the AsciiDoc source that are markup rather than prose.
 *
 * A listing block's attributes name a language, so a rule looking for `ruby`
 * would otherwise report the one in `[source,ruby]` (see #296), and a line
 * comment holds text the converter dropped (see #414). Each is replaced by a
 * run of `*` of the same width, so no position moves.
 *
 * Multiple-line comments -- a `////` block -- are not handled; a comment
 * inside one is masked line by line only where it also looks like a line
 * comment.
 */
export function prepADoc(content: string): string {
	let body = content.replace(RE_SOURCE, (match) => {
		let m = match;
		let offset = 0;
		if (m.endsWith(",]")) {
			offset = 1;
			m = m.replace(",]", "]");
		}
		const parts = m.split(",");
		const size = strLen(parts[parts.length - 1]);
		return `[source, ${"*".repeat(Math.max(size - 2 + offset, 0))}]`;
	});

	body = body.replace(
		RE_COMMENT,
		(m) => `// ${"*".repeat(strLen(m.replace(/^\/\/ /, "")))}`,
	);

	return body;
}
