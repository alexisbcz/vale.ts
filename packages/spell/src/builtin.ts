/**
 * Vale's built-in `en_US-web` dictionary.
 *
 * It ships as the two files in this package's `data` folder rather than as a
 * string in the source, so the text stays readable and diffable; they are
 * read on first use, and a caller that cannot reach a file system -- a
 * browser bundle, say -- can hand the same text in with
 * `setBuiltinDictionary` before anything asks for it.
 */

import { fileURLToPath } from "node:url";

import { readTextFile } from "./gospell.ts";

/** The dictionary's name, which a Vale vocabulary may give as its affix. */
export const builtinName = "en_US-web";

let aff: string | null = null;
let dic: string | null = null;

/**
 * Supplies the built-in dictionary's text, instead of reading it from this
 * package's `data` folder.
 *
 * A bundler that inlines the two files calls this once at startup; it has no
 * effect on a dictionary already loaded by name or by path.
 */
export function setBuiltinDictionary(affText: string, dicText: string): void {
	aff = affText;
	dic = dicText;
}

/** The built-in `.aff`, read on first use. */
export function builtinAffix(): string {
	if (aff === null) aff = readTextFile(dataPath(`${builtinName}.aff`));
	return aff;
}

/** The built-in `.dic`, read on first use. */
export function builtinDictionary(): string {
	if (dic === null) dic = readTextFile(dataPath(`${builtinName}.dic`));
	return dic;
}

/**
 * Where a data file lives, resolved against this module rather than the
 * working directory, so the package works wherever it is installed.
 */
function dataPath(name: string): string {
	return fileURLToPath(new URL(`../data/${name}`, import.meta.url));
}
