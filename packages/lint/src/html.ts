/**
 * Reading HTML, and reading plain text as a document.
 *
 * HTML needs no conversion, so this is the shortest reader there is: apply the
 * rewrites the configuration asks for, and hand the result to the walker.
 */

import { readFileSync } from "node:fs";
import type { Config, File } from "@vale-ts/core";
import { newE100 } from "@vale-ts/core";

/** What an HTML reader needs from the linter. */
export interface HTMLHost {
	config: Config;
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
}

/** Reads an HTML file. */
export function lintHTML(host: HTMLHost, f: File): void {
	// `--built` names the rendered output of a static-site generator, which is
	// what should be linted when the source is a template the generator owns.
	const built = host.config.flags.built;
	if (built !== "") {
		let html: string;
		try {
			html = readFileSync(built, "utf8");
		} catch (err) {
			throw newE100(f.path, err);
		}
		host.lintHTMLTokens(f, html, 0);
		return;
	}

	host.lintHTMLTokens(f, host.transform(f), 0);
}

/**
 * A manuscript in plain text marks its chapters by convention: a line of its
 * own reading "Chapter One", "Prologue", or "Part II", or a bare number.
 *
 * Read as a document, those lines are headings and what follows each is its
 * section, so a rule scoped to `heading` or a `doc(...)` selection reaches a
 * `.txt` manuscript as it does a Markdown one. A file with no such line is read
 * as it always was: one block of prose.
 */

/** A heading by name: the word, then at most a short title. */
const CHAPTER_LINE =
	/^(?:chapter|prologue|epilogue|interlude|afterword|foreword|preface)\b[^.!?]{0,60}$/i;

/** A division above the chapter. */
const PART_LINE = /^(?:part|book|act|volume)\b[^.!?]{0,60}$/i;

/** A chapter by number alone: a numeral or a roman numeral. */
const NUMBER_LINE = /^(?:\d{1,3}|[IVXLC]{1,7})\.?$/;

/** A scene break: asterisks, hashes, or dashes, spaced or not. */
const BREAK_LINE = /^(?:[*#~-]\s*){3,}$/;

/**
 * Renders plain text as a document when it has chapters, and reports whether it
 * does.
 *
 * Paragraphs are runs of lines between blank lines. The title is the first
 * paragraph when it is a single short line followed by a chapter, so the
 * paragraph after it is the opening.
 */
export function textToHTML(content: string): { html: string; ok: boolean } {
	const paras = content.split("\n\n");

	let chapters = 0;
	for (const p of paras) {
		const line = oneLine(p);
		if (line !== null && (CHAPTER_LINE.test(line) || NUMBER_LINE.test(line))) {
			chapters++;
		}
	}
	if (chapters === 0) return { html: "", ok: false };

	let out = "";
	for (let i = 0; i < paras.length; i++) {
		const text = paras[i]!.trim();
		if (text === "") continue;

		const line = oneLine(paras[i]!);
		if (line !== null && PART_LINE.test(line)) {
			out += `<h1>${escapeHTML(line)}</h1>\n`;
		} else if (
			line !== null &&
			(CHAPTER_LINE.test(line) || NUMBER_LINE.test(line))
		) {
			out += `<h2>${escapeHTML(line)}</h2>\n`;
		} else if (line !== null && BREAK_LINE.test(line)) {
			out += "<hr>\n";
		} else if (
			line !== null &&
			i === 0 &&
			words(line) <= 12 &&
			isChapterNext(paras)
		) {
			out += `<h1>${escapeHTML(line)}</h1>\n`;
		} else {
			out += `<p>${escapeHTML(text)}</p>\n`;
		}
	}

	return { html: out, ok: true };
}

/** A paragraph's text when it is a single line, and null otherwise. */
function oneLine(p: string): string | null {
	const text = p.trim();
	if (text === "" || text.includes("\n")) return null;
	return text;
}

/**
 * Whether the paragraph after the first is a chapter heading, which is what
 * makes the first a title.
 */
function isChapterNext(paras: readonly string[]): boolean {
	for (const p of paras.slice(1)) {
		if (p.trim() === "") continue;
		const line = oneLine(p);
		return (
			line !== null &&
			(CHAPTER_LINE.test(line) || NUMBER_LINE.test(line) || PART_LINE.test(line))
		);
	}
	return false;
}

function words(s: string): number {
	return s.split(/\s+/).filter((w) => w !== "").length;
}

function escapeHTML(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&#34;")
		.replaceAll("'", "&#39;");
}
