/** The shared scaffolding for the check tests. */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Block, type Config, type File, newConfig, newFlags } from "@vale-ts/core";
import { Manager, WORD_TEMPLATE } from "../src/index.ts";

/** A configuration that reads nothing off disk. */
export function testConfig(partial: Partial<Config> = {}): Config {
	const cfg = newConfig(newFlags({ ignoreGlobal: true }));
	Object.assign(cfg, partial);
	return cfg;
}

/**
 * A configuration with the default word template, which is what the manager
 * leaves unset and the rules then fall back to.
 */
export function wordTemplateConfig(): Config {
	const cfg = testConfig();
	cfg.wordTemplate = WORD_TEMPLATE;
	return cfg;
}

/** A block whose context is its own text. */
export function block(text: string, scope = ""): Block {
	return new Block("", text, scope);
}

/** A temporary directory that goes away with the process. */
export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "vale-check-"));
}

/** Writes `files`, keyed by a path relative to a new temporary directory. */
export function withStyles(files: Record<string, string>): string {
	const sp = tempDir();
	for (const [path, body] of Object.entries(files)) {
		const full = join(sp, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	return sp;
}

/** An empty manager over a styles path holding `files`. */
export function managerWithStyles(
	files: Record<string, string>,
): [Manager, string] {
	const sp = withStyles(files);
	const cfg = testConfig();
	cfg.addStylesPath(sp);
	return [new Manager(cfg), sp];
}

/** A stand-in for a linted file, for the rules that read one. */
export function testFile(partial: Partial<File> = {}): File {
	// The rules read only a handful of fields, so a structural stand-in keeps
	// the tests from depending on how a real file is built.
	const f = {
		vocab: [],
		sequences: [],
		scoped: {},
		nlp: {
			lang: "en",
			endpoint: "",
			scope: "",
			tagging: false,
			segmentation: false,
			splitting: false,
		},
		normedExt: "",
		realExt: "",
		...partial,
	};
	return f as unknown as File;
}
