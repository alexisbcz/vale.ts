/**
 * Vocabularies: the project's own list of words to accept and words to avoid.
 *
 * A vocabulary is a directory under `config/vocabularies`. The historical form
 * is two word lists, `accept.txt` and `reject.txt`, one term per line. The
 * YAML form, `vocab.yml`, says the same thing but lets a term carry options:
 * whether it is a pattern, whether case matters, and which affix flags to
 * expand it with.
 */

import { readFileSync } from "node:fs";
import { Regexp } from "@vale-ts/regex";
import { isMap, isScalar, isSeq, type Node, parseDocument } from "yaml";
import { newE201FromPosition, newE201FromTarget, ValeError } from "./errors.ts";
import { quoteMetaLike } from "./patterns.ts";

/** The names a YAML vocabulary may have. */
export const VOCAB_FILES = ["vocab.yml", "vocab.yaml"];

/** What one `config/vocabularies` directory holds. */
export interface Vocabulary {
	accepted: string[];
	rejected: string[];
}

export function newVocabulary(): Vocabulary {
	return { accepted: [], rejected: [] };
}

/** Returns the word forms a term's affix flags name. */
export type ExpandFunc = (word: string, flags: string) => string[];

/**
 * Resolves an affix file to the function that expands with it.
 *
 * `name` is what the vocabulary asked for and `affPath` is where it was found,
 * or "" when it was not -- an empty name, or the built-in dictionary's, is the
 * built-in expander's job.
 *
 * Core does not depend on the speller: a vocabulary that uses `flags` needs
 * one, and nothing else does, so the implementation is injected. The facade
 * package wires in `@vale-ts/spell`, which means a caller that never writes
 * `flags` never loads a dictionary.
 */
export type AffixResolver = (name: string, affPath: string) => ExpandFunc;

let resolveAffix: AffixResolver = (name) => {
	throw new Error(
		`a vocabulary entry asked for the affix flags of '${name || "the built-in dictionary"}', ` +
			"but no speller is registered; import `vale-ts` rather than `@vale-ts/core` directly",
	);
};

/** Where an affix file named by a vocabulary was found, or "". */
export type AffixFinder = (name: string) => string;

/** Registers the affix expander vocabularies use. */
export function setAffixResolver(fn: AffixResolver): void {
	resolveAffix = fn;
}

/** The name of the affix file of Vale's built-in dictionary. */
export const BUILTIN_AFFIX = "en_US-web";

/** Reads a word list: one term per line, with `# ` starting a comment. */
export function readWordList(path: string): string[] {
	const content = readFileSync(path, "utf8");
	return parseWordList(content);
}

/** `readWordList` for content already in hand. */
export function parseWordList(content: string): string[] {
	const terms: string[] = [];
	for (const line of content.split("\n")) {
		const word = line.trim();
		if (word.length === 0 || word.startsWith("# ")) continue;
		terms.push(word);
	}
	return terms;
}

/** The options a YAML vocabulary entry may carry. */
interface VocabOptions {
	flags: string;
	ignorecase: boolean;
	regex: boolean;
}

const VOCAB_KEYS = ["flags", "ignorecase", "regex"];

interface VocabEntry {
	term: string;
	opts: VocabOptions;
	line: number;
}

/** Adds the entries of the YAML vocabulary at `path` to `vocab`. */
export function readVocabYAML(
	path: string,
	vocab: Vocabulary,
	reportedPath = path,
	findAffix?: AffixFinder,
): void {
	const src = readFileSync(path, "utf8");
	parseVocabYAML(src, vocab, reportedPath, findAffix);
}

/** `readVocabYAML` for content already in hand. */
export function parseVocabYAML(
	src: string,
	vocab: Vocabulary,
	path: string,
	findAffix?: AffixFinder,
): void {
	const doc = parseDocument(src);
	if (doc.errors.length > 0) {
		const first = doc.errors[0]!;
		throw newE201FromPosition(first.message, path, lineOf(src, first.pos[0]));
	}

	const root = doc.contents;
	if (!isMap(root)) {
		if (root === null) return;
		throw newE201FromPosition(
			"a vocabulary is a mapping with `accept` and `reject` lists",
			path,
			1,
		);
	}

	let affix = "";
	const accept: VocabEntry[] = [];
	const reject: VocabEntry[] = [];

	for (const item of root.items) {
		const key = isScalar(item.key) ? String(item.key.value) : "";
		switch (key) {
			case "affix":
				affix = isScalar(item.value) ? String(item.value.value ?? "") : "";
				break;
			case "accept":
				accept.push(...readEntries(item.value, src, path));
				break;
			case "reject":
				reject.push(...readEntries(item.value, src, path));
				break;
			default:
				throw newE201FromTarget(
					`'${key}' isn't a vocabulary key; expected affix, accept, reject`,
					key,
					path,
				);
		}
	}

	let expand: ExpandFunc | null = null;
	const expander = (): ExpandFunc => {
		if (expand === null) {
			try {
				expand = resolveAffix(affix, findAffix?.(affix) ?? "");
			} catch (err) {
				throw newE201FromTarget(
					err instanceof Error ? err.message : String(err),
					affix,
					path,
				);
			}
		}
		return expand;
	};

	for (const [entries, into] of [
		[accept, vocab.accepted],
		[reject, vocab.rejected],
	] as const) {
		for (const e of entries) {
			let patterns: string[];
			try {
				patterns = entryPatterns(e, expander);
			} catch (err) {
				if (err instanceof ValeError) throw err;
				throw newE201FromPosition(
					err instanceof Error ? err.message : String(err),
					path,
					e.line,
				);
			}
			into.push(...patterns);
		}
	}
}

function readEntries(node: unknown, src: string, path: string): VocabEntry[] {
	if (node === null || node === undefined) return [];
	if (!isSeq(node)) {
		throw newE201FromPosition("`accept` and `reject` are lists", path, 1);
	}

	const out: VocabEntry[] = [];
	for (const raw of node.items) {
		out.push(readEntry(raw as Node, src, path));
	}
	return out;
}

function readEntry(node: Node, src: string, path: string): VocabEntry {
	const line = lineOf(src, node.range?.[0] ?? 0);
	const opts: VocabOptions = { flags: "", ignorecase: false, regex: false };

	if (isScalar(node)) {
		return { term: String(node.value ?? ""), opts, line };
	}

	if (!isMap(node) || node.items.length !== 1) {
		throw newE201FromPosition(
			"an entry is a term, or a term mapped to its options",
			path,
			line,
		);
	}

	const [pair] = node.items;
	const term = isScalar(pair!.key) ? String(pair!.key.value ?? "") : "";
	const value = pair!.value as Node | null;

	if (value === null || (isScalar(value) && value.value === null)) {
		return { term, opts, line };
	}
	if (isScalar(value)) {
		throw newE201FromPosition(
			`'${term}' maps to '${String(value.value)}', but a vocabulary entry maps to options; ` +
				"for a replacement, use a substitution rule",
			path,
			lineOf(src, value.range?.[0] ?? 0),
		);
	}
	if (!isMap(value)) {
		throw newE201FromPosition(`'${term}' should map to its options`, path, line);
	}

	for (const option of value.items) {
		const key = option.key as Node | null;
		const name = isScalar(key) ? String(key.value) : "";
		if (!VOCAB_KEYS.includes(name)) {
			throw newE201FromPosition(
				`'${name}' isn't a vocabulary option; expected ${VOCAB_KEYS.join(", ")}`,
				path,
				lineOf(src, key?.range?.[0] ?? 0),
			);
		}
		const read = isScalar(option.value) ? option.value.value : undefined;
		if (name === "flags") opts.flags = String(read ?? "");
		else if (name === "ignorecase") opts.ignorecase = read === true;
		else if (name === "regex") opts.regex = read === true;
	}

	return { term, opts, line };
}

/** What an entry contributes, as the patterns a `.txt` vocabulary would. */
function entryPatterns(e: VocabEntry, expander: () => ExpandFunc): string[] {
	const term = e.term.trim();
	if (term === "") throw new Error("an entry needs a term");

	let out: string[];
	if (e.opts.regex && e.opts.flags !== "") {
		throw new Error(`'${term}' can't have both 'regex' and 'flags'`);
	} else if (e.opts.regex) {
		try {
			Regexp.compile(term);
		} catch (err) {
			throw new Error(
				`'${term}' isn't a valid pattern: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		out = [term];
	} else if (e.opts.flags !== "") {
		out = expander()(term, e.opts.flags).map(quoteMetaLike);
	} else {
		out = [quoteMetaLike(term)];
	}

	if (e.opts.ignorecase) return out.map((p) => `(?i)${p}`);
	return out;
}

function lineOf(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < src.length; i++) {
		if (src[i] === "\n") line++;
	}
	return line;
}
