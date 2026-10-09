/**
 * The glue Vale calls the NLP package through: tagging a block of text, the
 * per-document cache that keeps it from happening twice, and the registry of
 * taggers a rule can name.
 */

import { readFileSync } from "node:fs";
import { segmenter } from "./segment/index.ts";
import { newTagger, open as openTagger, readDictionary } from "./tag/index.ts";
import { Lexical } from "./tag/lexical.ts";
import type { Tagging } from "./tag/types.ts";
import type { Token } from "./token.ts";
import { proseTokenizer } from "./words.ts";

/**
 * How a file wants its language handled.
 *
 * Vale assigns this per file so that a multi-language project works -- one
 * file might be `en` while another is `ja`.
 */
export interface Info {
	/** An API endpoint for a remote NLP service, or `""` for the built-in one. */
	endpoint: string;
	/** The file's language. */
	lang: string;
}

/** A word with its NLP context, as Vale's `sequence` check reads it. */
export interface TaggedWord {
	token: Token;
	line: number;
	span: number[];
}

/**
 * The taggers available by name, built on first use.
 *
 * A style may name more than one: rules ported from another checker want that
 * checker's idea of a noun, while everything already written expects prose's.
 */
const taggers = new Map<string, Tagging>();

/**
 * Makes a tagger available to rules under `name`, reading its dictionary from
 * `path`.
 *
 * The dictionary is Vale's existing asset kind, so a model ships, syncs and
 * resolves the same way a spelling dictionary does.
 */
export function registerModel(name: string, path: string): void {
	if (taggers.has(name)) return;

	const entries = readDictionary(readFileSync(path, "utf8"));
	taggers.set(name, new Lexical(entries, newTagger()));
}

/** Forgets every registered model. Meant for tests. */
export function resetModels(): void {
	taggers.clear();
}

/**
 * The tagger a rule asked for.
 *
 * An unknown name throws rather than falling back quietly: a rule written
 * against one tagger reads differently under another, so substituting one
 * would change what the rule means.
 */
export function taggerFor(name: string): Tagging {
	if (name === "") return defaultTagger();

	const t = taggers.get(name);
	if (t === undefined)
		throw new Error(`no tagger model named ${JSON.stringify(name)}`);
	return t;
}

let shared: Tagging | null = null;

/** prose's own tagger, used by every rule that does not name a model. */
function defaultTagger(): Tagging {
	if (shared === null) shared = openTagger("");
	return shared;
}

/**
 * Splits `text` into sentences, tags each one, and returns the tokens with
 * offsets relative to `text`.
 *
 * Tagging is per sentence because the tagger conditions on the previous two
 * tags; letting that context run across a sentence boundary would condition
 * the first word of each sentence on the last word of the one before it.
 */
export function tagText(text: string): Token[] {
	return tagTextWith("", text);
}

/** `tagText`, read with the named tagger. */
export function tagTextWith(model: string, text: string): Token[] {
	const t = taggerFor(model);

	const tokens: Token[] = [];
	for (const sent of segmenter().segment(text)) {
		const found = proseTokenizer().tokenize(sent.text);
		t.tagTokens(found);

		// Tokenizing reported offsets within the sentence; shift them so they
		// address the text the caller passed in.
		for (const tok of found) tok.start += sent.start;
		tokens.push(...found);
	}

	return tokens;
}

/**
 * Converts a string to a slice of tagged tokens.
 *
 * Tokens carry their offset within `text`, so
 * `text.slice(tok.start, tok.start + tok.text.length) === tok.text`.
 */
export function textToTokens(text: string, nlp?: Info | null): Token[] {
	if (nlp === undefined || nlp === null || nlp.endpoint === "")
		return tagText(text);
	throw remoteUnsupported();
}

/** `textToTokens`, read with the named tagger. */
export function textToTokensWith(
	model: string,
	text: string,
	info?: Info | null,
): Token[] {
	if (info === undefined || info === null || info.endpoint === "") {
		return tagTextWith(model, text);
	}
	// A remote endpoint does its own tagging, so there is no model to choose.
	throw remoteUnsupported();
}

/**
 * The error a remote endpoint gets.
 *
 * TODO: the Go implementation POSTs to `<endpoint>/tag` and `<endpoint>/segment`
 * for non-English text (`internal/nlp/http.go`). This port has no HTTP client
 * yet, so naming an endpoint is an error rather than a silent fall back to the
 * English model, which would mis-tag the text it was configured away from.
 */
function remoteUnsupported(): Error {
	return new Error("nlp: a remote NLP endpoint is not supported by this build");
}

/**
 * Remembers the tagging of each block within one document.
 *
 * Every `sequence` rule tags the sentence it is given, and a style may hold
 * hundreds of them -- so the same sentence was tagged once per rule. The
 * result depends only on the text, so it is computed once and shared.
 *
 * Scoped to a document: a cache living longer would hold every sentence a run
 * has ever seen.
 */
export class TokenCache {
	/** Tagged tokens by model name, then by text. */
	private readonly tagged = new Map<string, Map<string, Token[]>>();

	/** The tagged tokens of `text`, tagging it only the first time. */
	tokens(text: string, info?: Info | null): Token[] {
		return this.tokensWith("", text, info);
	}

	/** `tokens`, read with the named tagger. */
	tokensWith(model: string, text: string, info?: Info | null): Token[] {
		let byText = this.tagged.get(model);
		if (byText === undefined) {
			byText = new Map<string, Token[]>();
			this.tagged.set(model, byText);
		}

		const hit = byText.get(text);
		if (hit !== undefined) return hit;

		const toks = textToTokensWith(model, text, info);
		byText.set(text, toks);

		return toks;
	}
}
