/**
 * The averaged-perceptron part-of-speech tagger, after Honnibal's "A Good
 * Part-of-Speech Tagger in about 200 Lines of Python". It uses the Penn
 * Treebank tag set.
 *
 * # Why this file works in bytes
 *
 * The model's feature keys were trained byte-oriented: a word's "suffix" is
 * its last three *UTF-8 bytes* and its "prefix" is its first *byte*, not its
 * last three or first characters. For `café` the trained suffix is the bytes
 * of `fé` plus the lead byte of `é`, which is not a valid string at all. The
 * feature blob is likewise sorted bytewise.
 *
 * Switching to code points would be the natural port and would silently stop
 * matching learned features for every non-ASCII word -- it would not fail, it
 * would just tag worse. So the words are converted to UTF-8 once per sentence
 * and every feature key is assembled in that encoding. This is the one place
 * in the package that does not work in JavaScript string indices.
 */

import { isEmoticon } from "./emoticon.ts";
import type { Model } from "./flat.ts";
import { unmarshal } from "./flat.ts";
import type { Tagging, Token } from "./types.ts";

/**
 * Penn Treebank corpora mark traces and elisions with tokens like `*-1` or
 * `*T*-2`, and bracket certain literals as `-LRB-` / `-RRB-`. Both are passed
 * through rather than scored.
 */
const noneRe = /^(?:0|\*[\w?]\*|\*-\d{1,3}|\*[A-Z]+\*-\d{1,3}|\*)$/;
const keepRe = /^-[A-Z]{3}-$/;

/** The name the perceptron is registered under. */
export const DEFAULT = "perceptron";

/**
 * A lexicon fixes the tag for words that only ever carry one.
 *
 * The model predicts from context, which is what makes it general -- and what
 * makes it wrong on text that is not idiomatic. "aware" is an adjective in
 * every English sentence, but in "all ready aware of the risk" the surrounding
 * words are not evidence for anything, and the model settles on `NN`. A caller
 * that knows a word is unambiguous can say so.
 *
 * Lookups try the word as written, then its lower-case form, so one entry
 * covers "aware", "Aware" and "AWARE". Tags are not validated against the
 * model's own set: a caller may want a tag the model never emits.
 */
export type Lexicon = ReadonlyMap<string, string>;

const encoder = new TextEncoder();

/** The ASCII literals each feature key begins with, encoded once. */
const F_BIAS = encoder.encode("bias");
const F_I_SUFFIX = encoder.encode("i suffix ");
const F_I_PREF1 = encoder.encode("i pref1 ");
const F_IM1_TAG = encoder.encode("i-1 tag ");
const F_IM2_TAG = encoder.encode("i-2 tag ");
const F_TAG_PAIR = encoder.encode("i tag+i-2 tag ");
const F_I_WORD = encoder.encode("i word ");
const F_IM1_TAG_WORD = encoder.encode("i-1 tag+i word ");
const F_IM1_WORD = encoder.encode("i-1 word ");
const F_IM1_SUFFIX = encoder.encode("i-1 suffix ");
const F_IM2_WORD = encoder.encode("i-2 word ");
const F_IP1_WORD = encoder.encode("i+1 word ");
const F_IP1_SUFFIX = encoder.encode("i+1 suffix ");
const F_IP2_WORD = encoder.encode("i+2 word ");
const F_SPACE = encoder.encode(" ");

/** A growable byte buffer, reused across the tokens of one call. */
class KeyBuf {
	buf = new Uint8Array(96);
	len = 0;

	reset(): void {
		this.len = 0;
	}

	push(b: Uint8Array): void {
		if (this.len + b.length > this.buf.length) {
			let size = this.buf.length * 2;
			while (size < this.len + b.length) size *= 2;
			const grown = new Uint8Array(size);
			grown.set(this.buf.subarray(0, this.len));
			this.buf = grown;
		}
		this.buf.set(b, this.len);
		this.len += b.length;
	}
}

/** The per-call working set. */
interface Scratch {
	scores: Float32Array;
	key: KeyBuf;
	/** The normalized context words, in UTF-8. */
	ctx: Uint8Array[];
}

/**
 * The bytes of each tag string, cached.
 *
 * There are 38 tags plus two sentinels, so this fills up once and never grows.
 */
const tagBytes = new Map<string, Uint8Array>();

function bytesOf(tag: string): Uint8Array {
	let b = tagBytes.get(tag);
	if (b === undefined) {
		b = encoder.encode(tag);
		tagBytes.set(tag, b);
	}
	return b;
}

/**
 * Assigns part-of-speech tags with an averaged perceptron.
 *
 * It reads the words around the one it is tagging, which makes it accurate on
 * ordinary prose and unsteady on text that is not: a grammar rule fires on a
 * sentence that is already wrong, and the context there is not evidence for
 * anything. See `Lexical` for a tagger that leans on a dictionary instead.
 */
export class Tagger implements Tagging {
	private readonly model: Model;
	private readonly lexicon: Lexicon | null;

	constructor(model: Model, lexicon?: Lexicon) {
		this.model = model;
		this.lexicon = lexicon ?? null;
	}

	/** Which tagger this is. */
	name(): string {
		return DEFAULT;
	}

	/**
	 * Assigns a tag to each word and returns the tagged tokens.
	 *
	 * The input is treated as one sentence; the tagger conditions on the
	 * previous two tags, so sentence boundaries matter.
	 */
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

	/** Fills in the `tag` field of each token, using its `text`. */
	tagTokens(tokens: Token[]): void {
		if (tokens.length === 0) return;

		const s: Scratch = {
			scores: new Float32Array(this.model.classes.length),
			key: new KeyBuf(),
			ctx: [],
		};

		// The context is the normalized words padded with two sentinels at each
		// end, so `predict` can index i-2 .. i+2 without bounds checks.
		const need = tokens.length + 4;
		const ctx: Uint8Array[] = new Array(need);
		ctx[0] = bytesOf("-START-");
		ctx[1] = bytesOf("-START2-");
		for (let i = 0; i < tokens.length; i++) {
			ctx[i + 2] = encoder.encode(normalize(tokens[i]!.text));
		}
		ctx[need - 2] = bytesOf("-END-");
		ctx[need - 1] = bytesOf("-END2-");
		s.ctx = ctx;

		let p1 = "-START-";
		let p2 = "-START2-";
		for (let i = 0; i < tokens.length; i++) {
			const tag = this.tagOne(s, i, tokens[i]!.text, p1, p2);
			tokens[i]!.tag = tag;
			p2 = p1;
			p1 = tag;
		}
	}

	/**
	 * Resolves a single token. The special cases short-circuit the model for
	 * tokens it was never trained on.
	 */
	private tagOne(
		s: Scratch,
		i: number,
		word: string,
		p1: string,
		p2: string,
	): string {
		if (word === "-") return "-";
		if (isEmoticon(word)) return "SYM";
		if (word.startsWith("@")) return "NN";
		if (noneRe.test(word)) return "-NONE-";
		if (keepRe.test(word)) return word;

		// Ahead of the model's own lexicon: a caller supplying one is making a
		// more specific claim than the training data.
		const fixed = this.lookup(word);
		if (fixed !== undefined) return fixed;

		const known = this.model.tagFor(word);
		if (known !== undefined) return known;

		return this.predict(s, i, p1, p2);
	}

	/**
	 * Consults the caller's lexicon, trying the word as written before its
	 * lower-case form so that one entry covers every casing.
	 */
	private lookup(word: string): string | undefined {
		if (this.lexicon === null) return undefined;

		const exact = this.lexicon.get(word);
		if (exact !== undefined) return exact;

		const lower = word.toLowerCase();
		if (lower === word) return undefined;

		return this.lexicon.get(lower);
	}

	/** Scores the model's features for one token and returns the best tag. */
	private predict(s: Scratch, i: number, p1: string, p2: string): string {
		s.scores.fill(0);

		const ctx = s.ctx;
		const at = Math.min(ctx.length - 3, i + 2);

		const word = ctx[at]!;
		const suf = suffix(word, 3);
		const pre = prefix1(word);
		const iMinus = suffix(ctx[at - 1]!, 3);
		const iPlus = suffix(ctx[at + 1]!, 3);
		const p1b = bytesOf(p1);
		const p2b = bytesOf(p2);

		// Each feature is scored with weight 1. A feature that appears twice
		// contributes twice, which is correct because scoring is linear.
		this.feat(s, F_BIAS);
		this.feat(s, F_I_SUFFIX, suf);
		this.feat(s, F_I_PREF1, pre);
		this.feat(s, F_IM1_TAG, p1b);
		this.feat(s, F_IM2_TAG, p2b);
		this.feat(s, F_TAG_PAIR, p1b, F_SPACE, p2b);
		this.feat(s, F_I_WORD, word);
		this.feat(s, F_IM1_TAG_WORD, p1b, F_SPACE, word);
		this.feat(s, F_IM1_WORD, ctx[at - 1]!);
		this.feat(s, F_IM1_SUFFIX, iMinus);
		this.feat(s, F_IM2_WORD, ctx[at - 2]!);
		this.feat(s, F_IP1_WORD, ctx[at + 1]!);
		this.feat(s, F_IP1_SUFFIX, iPlus);
		this.feat(s, F_IP2_WORD, ctx[at + 2]!);

		return this.model.best(s.scores);
	}

	/** Assembles a feature key from parts and accumulates its weights. */
	private feat(s: Scratch, ...parts: Uint8Array[]): void {
		s.key.reset();
		for (const p of parts) s.key.push(p);
		this.model.accumulateInto(s.key.buf, 1, s.scores, s.key.len);
	}
}

/** The last `n` bytes of `w`, or all of `w` if shorter. */
export function suffix(w: Uint8Array, n: number): Uint8Array {
	if (w.length <= n) return w;
	return w.subarray(w.length - n);
}

/**
 * The first byte of `w`.
 *
 * Byte-oriented rather than character-oriented, deliberately: the model was
 * trained with these keys, so switching to code points would silently stop
 * matching learned features.
 */
export function prefix1(w: Uint8Array): Uint8Array {
	if (w.length === 0) return w;
	return w.subarray(0, 1);
}

/**
 * Maps a word onto the form the model was trained against.
 *
 * The length test is on UTF-8 bytes in Go, but `isDecimalInt` only accepts an
 * ASCII sign and ASCII digits, so a four-byte match is also four characters
 * and the two agree.
 */
export function normalize(word: string): string {
	if (word === "") return word;
	const first = word[0]!;
	if (first !== "-" && word.includes("-")) return "!HYPHEN";
	if (word.length === 4 && isDecimalInt(word)) return "!YEAR";
	if (first >= "0" && first <= "9") return "!DIGITS";
	return word.toLowerCase();
}

/**
 * Whether `s` is what Go's `strconv.Atoi` would accept: an optional sign
 * followed by at least one ASCII digit.
 */
function isDecimalInt(s: string): boolean {
	let i = 0;
	if (s[0] === "+" || s[0] === "-") i = 1;
	if (i === s.length) return false;
	for (; i < s.length; i++) {
		const c = s[i]!;
		if (c < "0" || c > "9") return false;
	}
	return true;
}

/** A tagger backed by a model in prose's flat format. */
export function fromBytes(data: Uint8Array, lexicon?: Lexicon): Tagger {
	return new Tagger(unmarshal(data), lexicon);
}
