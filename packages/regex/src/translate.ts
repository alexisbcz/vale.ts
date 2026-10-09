/**
 * Turns a Vale rule's pattern into a native `RegExp`.
 *
 * The result is cached: a style holds hundreds of rules, several of which tend
 * to be built from the same vocabulary, and translating is the one part of
 * compiling a rule that is pure.
 */

import type { Node } from "./ast.ts";
import { PatternError, parse } from "./parse.ts";
import { render, syntheticName, withNameMap } from "./render.ts";

export { PatternError };

export interface Translation {
	/** The pattern as written. */
	pattern: string;
	/** The body handed to `RegExp`. */
	source: string;
	/** The flags handed to `RegExp`, `g` and `d` included. */
	flags: string;
	/**
	 * Group names by capture number, in .NET's numbering: unnamed groups
	 * first, then named ones. Index 0 is the whole match and is always "".
	 */
	groupNames: string[];
	/** Capture number by group name. */
	nameToNumber: Map<string, number>;
	captureCount: number;
}

export interface TranslateOptions {
	/** Use JavaScript's ASCII `\b` rather than .NET's Unicode-aware one. */
	asciiWordBoundary?: boolean;
}

const cache = new Map<string, Translation | PatternError>();
const CACHE_LIMIT = 8192;

export function translate(
	pattern: string,
	opts: TranslateOptions = {},
): Translation {
	const key = opts.asciiWordBoundary ? `a\u0000${pattern}` : `u\u0000${pattern}`;
	const hit = cache.get(key);
	if (hit !== undefined) {
		if (hit instanceof PatternError) throw hit;
		return hit;
	}

	let result: Translation | PatternError;
	try {
		result = translateUncached(pattern, opts);
	} catch (err) {
		result =
			err instanceof PatternError
				? err
				: new PatternError(
						err instanceof Error ? err.message : String(err),
						pattern,
						0,
					);
	}

	if (cache.size >= CACHE_LIMIT) cache.clear();
	cache.set(key, result);
	if (result instanceof PatternError) throw result;
	return result;
}

function translateUncached(pattern: string, opts: TranslateOptions): Translation {
	const parsed = parse(pattern);

	const nameToNumber = new Map<string, number>();
	parsed.groupNames.forEach((name, number) => {
		if (name !== "" && !nameToNumber.has(name)) nameToNumber.set(name, number);
	});

	const rendered = withNameMap(nameToNumber, () =>
		render(parsed.root as Node, {
			source: pattern,
			asciiWordBoundary: opts.asciiWordBoundary,
		}),
	);

	let flags = "gd";
	if (rendered.flags.i) flags += "i";
	if (rendered.flags.m) flags += "m";
	if (rendered.flags.s) flags += "s";
	flags += rendered.needsSetOps || parsed.needsSetOps ? "v" : "u";

	let source = rendered.source;
	try {
		// biome-ignore lint/complexity/useRegexLiterals: the pattern is dynamic.
		new RegExp(source, flags);
	} catch (err) {
		// `v` mode is stricter than `u` about what a class may hold; a pattern
		// that only asked for `u` may still trip over it, so try the other way
		// round before giving up.
		const alt = flags.replace(/[uv]$/, flags.endsWith("v") ? "u" : "v");
		try {
			// biome-ignore lint/complexity/useRegexLiterals: the pattern is dynamic.
			new RegExp(source, alt);
			flags = alt;
		} catch {
			throw new PatternError(
				err instanceof Error ? err.message : String(err),
				pattern,
				0,
			);
		}
	}

	// An empty body is legal and matches everywhere, which is what the Go
	// engine does with `""` too.
	if (source === "") source = "(?:)";

	return {
		pattern,
		source,
		flags,
		groupNames: parsed.groupNames,
		nameToNumber,
		captureCount: parsed.captureCount,
	};
}

export { syntheticName };
