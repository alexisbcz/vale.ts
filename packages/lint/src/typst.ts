/**
 * Reading Typst, through `typst2vast`.
 *
 * Typst is its own grammar, so Vale reads it with its own parser: documents go
 * to `typst2vast`, which parses them with `typst-syntax` -- the compiler's
 * parser, error-tolerant and evaluation-free -- and emits the HTML the walker
 * reads.
 *
 * Nothing is compiled or executed: a document that does not build still
 * lints, no package is ever fetched, and no show rule can make the linted
 * text differ from the source. See #651.
 */

import type { File } from "@vale-ts/core";
import { newE100, which } from "@vale-ts/core";
import { executeWithInput } from "./external.ts";

/** What a Typst reader needs from the linter. */
export interface TypstHost {
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
	lintMetadata(f: File): void;
}

/** Reads a Typst file: its markup layer, parsed without evaluation. */
export function lintTypst(host: TypstHost, f: File): void {
	const exe = which(["typst2vast"]);
	if (exe === "") {
		throw newE100(
			f.path,
			new Error("typst2vast not found; it's needed to read Typst"),
		);
	}

	host.lintMetadata(f);

	const source = host.transform(f);

	let html: string;
	try {
		// One process per document. `typst2vast --batch` keeps a process up and
		// takes documents over a framed protocol, which needs a reply to be
		// read while the next document is written -- asynchronous, where every
		// reader here is synchronous. See `external.ts`.
		html = executeWithInput(exe, source);
	} catch (err) {
		throw newE100(f.path, err);
	}

	host.lintHTMLTokens(f, html, 0);
}
