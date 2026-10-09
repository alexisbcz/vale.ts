/**
 * Reading XML, through an XSLT stylesheet.
 *
 * XML carries no markup conventions of its own, so there is nothing to
 * convert: what an element means is a question about the schema. The file's
 * section names a stylesheet -- `Transform` -- and `xsltproc` runs it; the
 * HTML it produces is what the walker reads.
 *
 * Without a stylesheet there is nothing to do, and Vale says so rather than
 * reading the tags as prose.
 */

import type { File } from "@vale-ts/core";
import { newE100, which } from "@vale-ts/core";
import { executeWithInput } from "./external.ts";

/** What an XML reader needs from the linter. */
export interface XMLHost {
	lintHTMLTokens(f: File, raw: string, offset: number): void;
}

/**
 * The flags every run passes.
 *
 * Read-only: a run appends the stylesheet and `-` to a copy, never to this.
 * Appending to the shared list grew it by two per file, so the hundredth
 * document was converted with ninety-nine stale stylesheets ahead of its own.
 */
export const XSLT_ARGS: readonly string[] = [
	"--stringparam",
	"use.extensions",
	"0",
	"--stringparam",
	"generate.toc",
	"nop",
];

/** Reads an XML file. */
export function lintXML(host: XMLHost, f: File): void {
	const xsltproc = which(["xsltproc", "xsltproc.exe"]);
	if (xsltproc === "") {
		throw newE100(
			f.path,
			new Error("xsltproc not found; it's needed to read XML"),
		);
	}
	if (f.transform === "") {
		throw newE100(
			f.path,
			new Error(
				"no XSLT transform provided; set Transform in this file's section",
			),
		);
	}

	let html: string;
	try {
		html = executeWithInput(xsltproc, f.content, [
			...XSLT_ARGS,
			f.transform,
			"-",
		]);
	} catch (err) {
		throw newE100(f.path, err);
	}

	host.lintHTMLTokens(f, html, 0);
}
