/** The shared scaffolding for the spell tests. */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { GoSpell } from "../src/index.ts";
import { newGoSpellBytes, newGoSpellReader } from "../src/index.ts";

/** A speller over a `.aff` and `.dic` pair written inline. */
export function speller(aff: string, dic: string): GoSpell {
	return newGoSpellReader(aff, dic);
}

/** Where the Hunspell fixtures live. */
export function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export function readFixture(name: string): Uint8Array {
	const buf = readFileSync(fixturePath(name));
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** The stems of the Hunspell fixtures, one per `.aff`. */
export function hunspellStems(): string[] {
	return readdirSync(fixturePath("hunspell"))
		.filter((n) => n.endsWith(".aff"))
		.map((n) => n.slice(0, -".aff".length))
		.sort();
}

/** A speller over the Hunspell fixture with the given stem. */
export function hunspellSpeller(stem: string): GoSpell {
	return newGoSpellBytes(
		readFixture(`hunspell/${stem}.aff`),
		readFixture(`hunspell/${stem}.dic`),
	);
}

/**
 * A fixture file's non-empty lines, or none when the file does not exist.
 *
 * Hunspell's own runner feeds the word lists in as UTF-8 whatever the
 * dictionary's SET says, so they are read that way here too.
 */
export function hunspellLines(name: string): string[] {
	let text: string;
	try {
		text = new TextDecoder("utf-8").decode(readFixture(name));
	} catch {
		return [];
	}
	if (text.startsWith("﻿")) text = text.slice(1);

	const out: string[] = [];
	for (let line of text.split("\n")) {
		line = line.replace(/\r+$/, "");
		if (line.trim() !== "") out.push(line);
	}
	return out;
}

/** Splits a line of a `.good` or `.wrong` file into its words. */
export function words(line: string): string[] {
	return line
		.trim()
		.split(/\s+/)
		.filter((w) => w !== "");
}
