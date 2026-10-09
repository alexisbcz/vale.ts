/**
 * `@vale-ts/models` -- the trained models Vale's language work depends on.
 *
 * Both are the files the Go implementation ships, byte for byte, so that the
 * two agree about where a sentence ends and what part of speech a word is.
 * They are data rather than code: the readers live in `@vale-ts/nlp`.
 *
 * - `en-pos.bin` is `prose`'s averaged-perceptron model for English, in that
 *   project's flat format (magic `PROSETAG`).
 * - `punkt-english.json` is the Punkt training data from
 *   `neurosnap/sentences`, which is what `prose`'s segmenter is built on.
 *
 * Both are MIT-licensed; their notices sit beside them in `data/`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the model files live. */
export const DATA_DIR = join(here, "..", "data");

/** The path of the English part-of-speech model. */
export const POS_MODEL_PATH = join(DATA_DIR, "en-pos.bin");

/** The path of the English Punkt sentence model. */
export const PUNKT_MODEL_PATH = join(DATA_DIR, "punkt-english.json");

let posBytes: Uint8Array | null = null;

/**
 * The English part-of-speech model's bytes.
 *
 * Read once per process: the file is 3.4 MB, and most runs tag nothing at all,
 * so nothing here is touched until a rule asks for a tag.
 */
export function posModel(): Uint8Array {
	if (posBytes === null) posBytes = readFileSync(POS_MODEL_PATH);
	return posBytes;
}

/** The shape the Punkt training data has on disk. */
export interface PunktTraining {
	AbbrevTypes: Record<string, number>;
	Collocations: Record<string, number>;
	SentStarters: Record<string, number>;
	OrthoContext: Record<string, number>;
}

let punkt: PunktTraining | null = null;

/** The English Punkt training data, parsed once per process. */
export function punktModel(): PunktTraining {
	if (punkt === null) {
		punkt = JSON.parse(readFileSync(PUNKT_MODEL_PATH, "utf8")) as PunktTraining;
	}
	return punkt;
}
