/**
 * Expanding the `word/FLAGS` tokens of a rule that sets `affix`.
 *
 * A style that wants every inflected form of a word -- `rebase`, `rebased`,
 * `rebasing` -- would otherwise have to list them, and keep the list in step
 * with the dictionary. Naming the affix file instead lets the speller enumerate
 * them, which is the same expansion a vocabulary entry's `flags` gets.
 */

import {
	BUILTIN_AFFIX,
	type Config,
	DICT_DIR,
	fileExists,
	joinPath,
	newE201FromTarget,
	relToWD,
	setAffixResolver,
} from "@vale-ts/core";
import { quoteMeta } from "@vale-ts/regex";
import { expand, expandWith } from "@vale-ts/spell";

/** Returns the word forms a term's affix flags name. */
export type ExpandFunc = (word: string, flags: string) => string[];

/**
 * The `.aff` file `name` refers to, searched the way a dictionary is: under
 * `config/dictionaries` on each search path, then in `$DICPATH`.
 */
export function findAffix(cfg: Config | null, name: string): string {
	if (name === "") return "";
	const file = `${name}.aff`;

	const roots: string[] = [];
	if (cfg !== null) {
		for (const p of cfg.searchPaths()) roots.push(joinPath(p, DICT_DIR));
	}
	const dicpath = process.env.DICPATH;
	if (dicpath !== undefined && dicpath !== "") roots.push(dicpath);

	for (const root of roots) {
		const candidate = joinPath(root, file);
		if (fileExists(candidate)) return candidate;
	}
	return "";
}

/**
 * The expander for the named affix file.
 *
 * An affix file is one half of a dictionary, so it is resolved the same way;
 * an unnamed one, or the built-in one by name, is the dictionary Vale ships.
 */
export function affixExpander(cfg: Config | null, name: string): ExpandFunc {
	const aff = findAffix(cfg, name);
	if (aff !== "") return (word, flags) => expandWith(aff, word, flags);
	if (name === "" || name === BUILTIN_AFFIX) return expand;
	throw new Error(`'${name}.aff' not found in ${DICT_DIR} or $DICPATH`);
}

/**
 * Teaches the configuration layer how to expand a vocabulary entry's `flags`.
 *
 * `@vale-ts/core` does not depend on the speller, because a vocabulary that
 * writes `flags:` is the only thing in it that needs one. This package already
 * does, and every path that can lint loads this one -- a `Manager` is how rules
 * come to exist -- so the wiring belongs here rather than in each entry point,
 * where one of them would eventually forget.
 */
export function registerSpeller(): void {
	setAffixResolver((name, affPath) => {
		if (affPath !== "") return (word, flags) => expandWith(affPath, word, flags);
		if (name === "" || name === BUILTIN_AFFIX) return expand;
		throw new Error(`'${name}.aff' not found in ${DICT_DIR} or $DICPATH`);
	});
}

// Registered on load: a vocabulary is read while the configuration is, which
// is before anything has had a chance to call the function above.
registerSpeller();

/**
 * Expands each `word/FLAGS` word in a rule's tokens into an alternation of the
 * forms its flags name. A slash escaped as `\/` is text.
 */
export function affixTokens(
	cfg: Config | null,
	affix: string,
	tokens: readonly string[],
	rulePath: string,
): string[] {
	if (affix === "") return [...tokens];

	const path = relToWD(rulePath);

	let expand: ExpandFunc;
	try {
		expand = affixExpander(cfg, affix);
	} catch (err) {
		throw newE201FromTarget(messageOf(err), affix, path);
	}

	return tokens.map((token) => {
		try {
			return affixToken(expand, token);
		} catch (err) {
			throw newE201FromTarget(messageOf(err), token, path);
		}
	});
}

/**
 * `token` with each space-separated `word/FLAGS` part replaced by an
 * alternation of its forms. Other parts, and a token with no unescaped slash,
 * are left as written.
 */
export function affixToken(expand: ExpandFunc, token: string): string {
	const parts = token.split(" ");
	for (let i = 0; i < parts.length; i++) {
		let part = parts[i]!;
		let cut = unescapedSlash(part);
		if (cut < 0) continue;

		// A word boundary on either side stays outside the alternation.
		let before = "";
		let after = "";
		if (part.startsWith("\\b")) {
			before = "\\b";
			part = part.slice(2);
			cut -= 2;
		}
		if (part.endsWith("\\b")) {
			after = "\\b";
			part = part.slice(0, -2);
		}

		const word = part.slice(0, cut).replaceAll("\\/", "/");
		if (quoteMeta(word) !== word) {
			throw new Error(
				`'${part}' has affix flags, so its word must be plain text; write a literal slash as '\\/'`,
			);
		}

		let forms: string[];
		try {
			forms = expand(word, part.slice(cut + 1));
		} catch (err) {
			throw new Error(
				`'${part}': ${messageOf(err)}; write a literal slash as '\\/'`,
			);
		}

		parts[i] = `${before}(?:${forms.map(quoteMeta).join("|")})${after}`;
	}
	return parts.join(" ");
}

/** The index of the last `/` in `s` not preceded by a backslash, or -1. */
export function unescapedSlash(s: string): number {
	for (let i = s.length - 1; i >= 0; i--) {
		if (s[i] === "/" && (i === 0 || s[i - 1] !== "\\")) return i;
	}
	return -1;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
