/**
 * `@vale-ts/nlp` -- the language work Vale's checks are built on.
 *
 * Four things live here, each a port of what the Go implementation uses:
 *
 *  - `IterTokenizer` (`tokenize.ts`), the word extractor for spelling and for
 *    locating a match, and prose's positioned tokenizer (`words.ts`);
 *  - a Punkt sentence segmenter (`segment/`);
 *  - an averaged-perceptron part-of-speech tagger (`tag/`);
 *  - readability metrics (`summarize/`).
 *
 * # Offsets
 *
 * There is one offset unit: the JavaScript string index, a UTF-16 code unit,
 * used wherever Go uses a byte offset into a string. Where Go counts runes,
 * this counts code points (`strLen`). The part-of-speech model is the single
 * exception -- its feature keys are byte-oriented, and `tag/tagger.ts` says why.
 *
 * Every token and sentence carries where it came from, and
 * `src.slice(t.start, t.start + t.text.length) === t.text` holds throughout.
 *
 * # One qualified name
 *
 * `summarize` is re-exported under its own name rather than flattened. Go has
 * both `segment.Sentence` and `summarize.Sentence`, two different types, so a
 * flat re-export would have to rename one of them. `Document` and
 * `newDocument`, the two names Vale reaches for directly, are also available
 * unqualified.
 */

export * from "./info.ts";
export * from "./quote.ts";
export * from "./segment/index.ts";
export * as summarize from "./summarize/index.ts";
export { Document, newDocument } from "./summarize/index.ts";
export * from "./tag/index.ts";
export * from "./token.ts";
export * from "./tokenize.ts";
export * from "./util.ts";
export * from "./words.ts";
