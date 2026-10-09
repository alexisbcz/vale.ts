/**
 * The part-of-speech tagging cache a `sequence` rule reads through.
 *
 * Every `sequence` rule tags the sentence it is given, and a style may hold
 * hundreds of them, so the same sentence was tagged once per rule. The result
 * depends only on the text and the model, so it is computed once and shared.
 *
 * The cache is held per file, keyed weakly, so it dies with the file rather
 * than holding every sentence a run has ever seen.
 *
 * TODO: this belongs on `File`, as Go's `file.TokensWith` is. It lives here
 * because `@vale-ts/core`'s `File` does not expose it yet; move it when it
 * does, and this module goes away.
 */

import type { File } from "@vale-ts/core";
import { type Token, TokenCache, textToTokensWith } from "@vale-ts/nlp";

const caches = new WeakMap<File, TokenCache>();

/** The tagged tokens of `text`, read with the model the rule named. */
export function tokensWith(
	file: File | null,
	model: string,
	text: string,
): Token[] {
	if (file === null) {
		// Nothing to key a cache on, and no document to bound its life.
		return textToTokensWith(model, text, null);
	}

	let cache = caches.get(file);
	if (cache === undefined) {
		cache = new TokenCache();
		caches.set(file, cache);
	}
	return cache.tokensWith(model, text, file.nlp);
}
