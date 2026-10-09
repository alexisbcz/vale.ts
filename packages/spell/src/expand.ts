/**
 * Turning a vocabulary entry's affix flags into the words it stands for.
 *
 * A Vale vocabulary may write an entry as `failover/S` rather than listing
 * `failover` and `failovers`, which is what the config layer calls these to
 * resolve. They expand against an affix file alone -- no `.dic` is read -- so
 * a flag the file does not define is an error rather than a silently empty
 * result: the entry is the author's, and a typo in it should be reported.
 */

import type { DictConfig } from "./aff.ts";
import { newDictConfig } from "./aff.ts";
import { builtinAffix } from "./builtin.ts";
import { decodeDictionary } from "./encoding.ts";
import { readBinaryFile } from "./gospell.ts";

/** The built-in affix file, read and parsed once. */
let defaultConfig: DictConfig | null = null;

/** Each `.aff` file `expandWith` has read, by path. */
const affixFiles = new Map<string, DictConfig>();

/**
 * The words that `word` with the given affix flags generates, such as
 * `failover` and `S`, under Vale's default affix file.
 */
export function expand(word: string, flags: string): string[] {
	if (defaultConfig === null) defaultConfig = newDictConfig(builtinAffix());
	return expandConfig(defaultConfig, "the default dictionary", word, flags);
}

/** `expand` under the `.aff` file at `path`. */
export function expandWith(path: string, word: string, flags: string): string[] {
	let cached = affixFiles.get(path);
	if (cached === undefined) {
		const raw = readBinaryFile(path);
		const decoded = decodeDictionary(raw, new Uint8Array());
		cached = newDictConfig(decoded.aff);
		affixFiles.set(path, cached);
	}
	return expandConfig(cached, basename(path), word, flags);
}

/** `expandWith` over the contents of a `.aff`, for a caller without a file. */
export function expandWithContent(
	aff: string,
	word: string,
	flags: string,
	name = "the given affix file",
): string[] {
	return expandConfig(newDictConfig(aff), name, word, flags);
}

function expandConfig(
	aff: DictConfig,
	name: string,
	word: string,
	flags: string,
): string[] {
	if (flags === "") return [word];
	if (word === "") throw new Error(`flags '${flags}' need a word`);

	const keys = aff.parseFlags(flags);
	for (const flag of keys) {
		if (!aff.affixMap.has(flag)) {
			throw new Error(`'${flag}' isn't an affix flag in ${name}`);
		}
	}

	const seen = new Set<string>();
	const words: string[] = [];
	for (const f of aff.expander(null, null).root(word, keys)) {
		if (!seen.has(f.word)) {
			seen.add(f.word);
			words.push(f.word);
		}
	}
	return words;
}

/** The last path element, as `filepath.Base` reports it. */
function basename(path: string): string {
	const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return at < 0 ? path : path.slice(at + 1);
}
