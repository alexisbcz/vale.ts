/**
 * Part-of-speech tagging: the averaged perceptron, the dictionary-backed
 * tagger built on top of it, and the registry a rule names one through.
 */

import { posModel } from "@vale-ts/models";
import type { Model } from "./flat.ts";
import { unmarshal } from "./flat.ts";
import type { Lexicon } from "./tagger.ts";
import { DEFAULT, Tagger } from "./tagger.ts";
import type { Factory, Tagging } from "./types.ts";

export * from "./emoticon.ts";
export * from "./flat.ts";
export * from "./lexical.ts";
export * from "./tagger.ts";
export * from "./types.ts";

let model: Model | null = null;

/**
 * The built-in English model, decoded once per process.
 *
 * Decoding is the tagger's only meaningful cost -- a few megabytes of copying
 * and 75,000 offsets -- so it happens on first use rather than at import, and
 * a run that tags nothing never reads the file.
 */
export function englishModel(): Model {
	if (model === null) model = unmarshal(posModel());
	return model;
}

/**
 * A tagger backed by the built-in English model.
 *
 * The model is loaded on the first call and shared thereafter, so calling this
 * repeatedly is cheap.
 */
export function newTagger(lexicon?: Lexicon): Tagger {
	return new Tagger(englishModel(), lexicon);
}

const registry = new Map<string, Factory>();

/**
 * Makes a tagger available by name.
 *
 * Registering the same name twice throws: it means two callers disagree about
 * what that name refers to, and picking one silently would make the choice
 * depend on import order.
 */
export function register(name: string, f: Factory): void {
	if (registry.has(name)) throw new Error(`tag: ${name} is already registered`);
	registry.set(name, f);
}

/** Builds the tagger registered under `name`; an empty name gives the default. */
export function open(name: string): Tagging {
	const key = name === "" ? DEFAULT : name;
	const f = registry.get(key);
	if (f === undefined) {
		throw new Error(
			`tag: no tagger named ${JSON.stringify(key)}; have ${names().join(", ")}`,
		);
	}
	return f();
}

/** The registered taggers, sorted. */
export function names(): string[] {
	return [...registry.keys()].sort();
}

register(DEFAULT, () => newTagger());
