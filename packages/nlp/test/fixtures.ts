/**
 * Loading the fixtures the tests share.
 *
 * All of them are copies of prose's `testdata`, so a test here asserts against
 * the same table the Go test does.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the fixtures live. */
export const FIXTURES = join(here, "fixtures");

/** Reads and parses a JSON fixture. */
export function json<T>(name: string): T {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

/** Reads a fixture's lines, dropping the empty one a trailing newline leaves. */
export function lines(name: string): string[] {
	return readFileSync(join(FIXTURES, name), "utf8")
		.split("\n")
		.filter((l) => l !== "");
}

/** One case of the standard Punkt accuracy suite. */
export interface GoldenRule {
	name: string;
	input: string;
	output: string[];
}

/**
 * The corpus the offset invariants run over: the sentences of prose's
 * `treebank_sents.json`, with punctuation and Unicode intact.
 */
export function corpus(): string[] {
	return json<string[]>("treebank_sents.json");
}

/**
 * The multi-sentence texts those sentences were cut from.
 *
 * Useful where the corpus itself is not: a segmenter has nothing to do with a
 * single sentence, but plenty to get wrong across `tokenize.json`'s
 * abbreviations, ellipses and quoted speech.
 */
export function rawTexts(): string[] {
	return json<string[]>("tokenize.json");
}
