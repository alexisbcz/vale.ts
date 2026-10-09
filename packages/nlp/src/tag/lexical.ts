/**
 * The dictionary-backed tagger.
 *
 * This is how a grammar checker usually tags: `aware` is an adjective in every
 * English sentence, and a dictionary says so without reading the words around
 * it. A contextual tagger has to infer it, and infers badly when the sentence
 * is ungrammatical -- which is exactly the sentence a grammar rule is looking
 * at. In "they were all ready aware of the risk" the perceptron reads `aware`
 * as a noun, because the words beside it are not evidence for anything.
 *
 * The cost is the other direction: a dictionary cannot tell `code` the noun
 * from `code` the verb. Words the dictionary lists more than one way are left
 * to the fallback, so context still decides where context is what decides.
 */

import type { Tagging, Token } from "./types.ts";

/** A word mapped to the tags it can take, most common first. */
export type Dictionary = ReadonlyMap<string, readonly string[]>;

export class Lexical implements Tagging {
	private readonly entries: Dictionary;
	private readonly fallback: Tagging;

	/**
	 * Builds a dictionary-driven tagger.
	 *
	 * `fallback` handles unknown and ambiguous words.
	 */
	constructor(entries: Dictionary, fallback: Tagging) {
		if (entries.size === 0)
			throw new Error("tag: a lexical tagger needs a dictionary");
		this.entries = entries;
		this.fallback = fallback;
	}

	name(): string {
		return "lexical";
	}

	/** Assigns a tag to each word and returns the tagged tokens. */
	tag(words: string[]): Token[] {
		const out: Token[] = words.map((w) => ({
			text: w,
			tag: "",
			label: "",
			start: 0,
		}));
		this.tagTokens(out);
		return out;
	}

	/**
	 * Fills in the `tag` field of each token.
	 *
	 * The fallback runs over the whole sentence rather than word by word: it
	 * reads the tags around each word, so handing it only the words the
	 * dictionary could not place would have it reading a sentence with holes
	 * in it.
	 */
	tagTokens(tokens: Token[]): void {
		if (tokens.length === 0) return;

		this.fallback.tagTokens(tokens);

		for (const token of tokens) {
			const tags = this.lookup(token.text);
			if (tags === undefined || tags.length === 0) continue;

			// One possibility: the dictionary decides.
			if (tags.length === 1) {
				token.tag = tags[0]!;
				continue;
			}

			// Several: keep the fallback's answer when it is among them, since
			// context is what tells them apart.
			if (tags.includes(token.tag)) continue;

			// The fallback chose a reading the dictionary does not list -- `VBP`
			// where it allows `VB`. Its answer is still evidence of the *class*,
			// so prefer a listed tag of that class over the first one: the model
			// said verb, and switching to noun because noun happens to be listed
			// first would throw away the one thing it was sure of.
			const same = sameClass(tags, token.tag);
			if (same !== undefined) {
				token.tag = same;
				continue;
			}

			token.tag = tags[0]!;
		}
	}

	/**
	 * Finds a word, trying it as written before its lower-case form so one
	 * entry covers every casing.
	 */
	private lookup(word: string): readonly string[] | undefined {
		const exact = this.entries.get(word);
		if (exact !== undefined) return exact;

		const lower = word.toLowerCase();
		if (lower === word) return undefined;

		return this.entries.get(lower);
	}
}

/**
 * A tag among `tags` that describes the same part of speech as `want`,
 * ignoring the finer distinctions Penn packs into the tag.
 *
 * Penn encodes class and inflection together -- NN/NNS, VB/VBD/VBG -- and the
 * first letters are the class. Two tags sharing them are the same kind of word
 * in different forms.
 */
function sameClass(tags: readonly string[], want: string): string | undefined {
	const cls = classOf(want);
	if (cls === "") return undefined;

	for (const t of tags) {
		if (classOf(t) === cls) return t;
	}

	return undefined;
}

/** Reduces a Penn tag to the part of speech it names. */
function classOf(tag: string): string {
	if (tag.startsWith("NNP")) return "NNP";
	if (tag.startsWith("NN")) return "NN";
	if (tag.startsWith("VB")) return "VB";
	if (tag.startsWith("JJ")) return "JJ";
	if (tag.startsWith("RB")) return "RB";
	if (tag.startsWith("PRP")) return "PRP";
	return tag;
}

/**
 * Parses a dictionary of one word per line:
 *
 *     aware	JJ
 *     code	NN	VB
 *
 * Fields are tab-separated: the word, then every tag it can take, most common
 * first. Blank lines and lines beginning with `#` are ignored.
 */
export function readDictionary(text: string): Map<string, string[]> {
	const entries = new Map<string, string[]>();

	// Split the way `bufio.Scanner` does, so a CRLF file reads the same.
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		let raw = lines[i]!;
		if (raw.endsWith("\r")) raw = raw.slice(0, -1);
		// A trailing newline leaves one empty element that Go never scans.
		if (i === lines.length - 1 && raw === "") break;

		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;

		const fields = line.split("\t");
		if (fields.length < 2) {
			throw new Error(`tag: line ${i + 1}: want a word and at least one tag`);
		}

		const word = fields[0]!.trim();
		const tags: string[] = [];
		for (const f of fields.slice(1)) {
			const t = f.trim();
			if (t !== "") tags.push(t);
		}

		if (word === "" || tags.length === 0) {
			throw new Error(`tag: line ${i + 1}: want a word and at least one tag`);
		}
		entries.set(word, tags);
	}

	return entries;
}
