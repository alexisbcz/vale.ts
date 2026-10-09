/**
 * `sequence`: a pattern over tagged tokens rather than over characters.
 *
 * Each entry of `tokens` is one position in the sentence, naming the word it
 * accepts (`pattern`), its part of speech (`tag` or `upos`), or both. The rule
 * fires where the whole sequence lines up.
 */

import {
	type Alert,
	type Block,
	type Config,
	DICT_DIR,
	type File,
	findConfigAsset,
	newE201FromPosition,
	newE201FromTarget,
} from "@vale-ts/core";
import { registerModel, type Token } from "@vale-ts/nlp";
import { Regexp, Required, weight } from "@vale-ts/regex";
import { resolveFix } from "./action.ts";
import { runeSpanToBytes } from "./anchor.ts";
import type { BaseCheck } from "./decode.ts";
import { Fields } from "./decode.ts";
import {
	checkScopes,
	type Definition,
	fillTemplate,
	formatMessages,
	IGNORE_CASE,
	makeRegexp,
	re2Loc,
	readDefinition,
	readStructureError,
	type Rule,
	TOKEN_TEMPLATE,
} from "./definition.ts";
import { recase } from "./matchcase.ts";
import { patternError } from "./pattern-error.ts";
import { tokensWith } from "./tokens.ts";
import { intInSlice } from "./util.ts";
import { uposTagPattern, uposWordPattern } from "./upos.ts";

/** One position in a sequence, with its NLP-related attributes. */
export interface NLPToken {
	pattern: string;
	tag: string;
	skip: number;

	/**
	 * `min` (`int`): how many times the token must occur -- "at least two
	 * nouns", not just one. Each occurrence gets its own `skip` window, so
	 * `skip: 8, min: 2` reads "a noun within eight words, then another noun
	 * within eight words". The default is 1.
	 */
	min: number;

	/**
	 * `upos` matches a universal part-of-speech tag -- NOUN, VERB, ADJ -- rather
	 * than a Penn Treebank one.
	 *
	 * It compiles down to the equivalent Penn tags, plus a word constraint for
	 * the few categories Penn cannot express. Rules written against universal
	 * tags are portable; rules written against Penn tags are more precise.
	 */
	upos: string;

	/**
	 * `target` narrows the alert to this token alone.
	 *
	 * Without it a match spans every token in the sequence. Marking one lets a
	 * rule require surrounding context while pointing at only the part the
	 * writer should change -- "flag the space, but only between these two
	 * words".
	 */
	target: boolean;

	negate: boolean;

	/**
	 * Finds candidate positions by scanning the whole sentence, so it must not
	 * be anchored.
	 */
	re: Regexp | null;

	/**
	 * Matches the token's part-of-speech tag. Compiled once with the rule:
	 * this is tested against every word of every sentence, and compiling it
	 * per call was the single largest cost in a tag-heavy style.
	 */
	tagRe: Regexp | null;

	/**
	 * Tests one token, so it must be anchored. A `pattern` names the word a
	 * position accepts: without anchoring, `self` also accepts the single
	 * token `self-worth`, and a rule for `your self` fires on `your
	 * self-worth`.
	 */
	tokenRe: Regexp | null;

	/**
	 * Narrows a universal tag to the words it can apply to.
	 *
	 * Kept apart from `re` because that one doubles as the anchor and is run
	 * against the whole sentence; this is only ever tested against a single
	 * token's text.
	 */
	wordRe: Regexp | null;

	optional: boolean;
	start: boolean;
	end: boolean;

	/**
	 * Ties the expanded copies of one occurrence together: a `skip` window's
	 * fillers and the required token they pad. When any copy matches, the walk
	 * moves past the whole group -- and no further, so the tokens after it are
	 * still verified.
	 */
	group: number;
}

function newNLPToken(): NLPToken {
	return {
		pattern: "",
		tag: "",
		skip: 0,
		min: 0,
		upos: "",
		target: false,
		negate: false,
		re: null,
		tagRe: null,
		tokenRe: null,
		wordRe: null,
		optional: false,
		start: false,
		end: false,
		group: 0,
	};
}

export class Sequence implements Rule {
	private readonly definition: Definition;

	readonly tokens: NLPToken[] = [];

	/**
	 * `model` (`string`): the tagger to read this rule's tags with.
	 *
	 * Rules ported from another checker are written against that checker's
	 * idea of a noun, and read differently under this one's. Naming its model
	 * here has them read as intended. A model is a dictionary under
	 * `config/dictionaries`, so it ships and syncs like any other asset.
	 */
	readonly model: string;

	/**
	 * `exceptions` (`array`): patterns matched against the sentence; a match
	 * that *begins inside* one of their regions is dropped.
	 *
	 * Tokens see the sentence one word at a time, so a guard about a region --
	 * "the comma closing a fronted phrase is not a list comma" -- is not
	 * expressible as a token. An exception hands that judgment to a pattern,
	 * which is the right tool for it, while the tokens keep doing the
	 * part-of-speech work.
	 *
	 * Unlike other checks' `exceptions`, these are not vocabulary terms and
	 * the project's accepted tokens are never merged in.
	 */
	readonly exceptions: string[];

	readonly ignorecase: boolean;

	/** Whether any token names a tag, which is what asks for tagging. */
	needsTagging = false;

	private readonly exceptRe: Regexp[] = [];

	/**
	 * Literals the sentence must contain one of.
	 *
	 * Every token in the sequence has to match, so any one token's requirement
	 * is the whole rule's. Tokens that only name a tag contribute nothing, and
	 * a rule made entirely of those gets no filter.
	 *
	 * This matters more here than elsewhere: `run` tags the block before it
	 * does anything else, so ruling the rule out first skips the tagger too.
	 */
	private readonly filter: string[];

	constructor(cfg: Config | null, generic: BaseCheck, path: string) {
		try {
			this.makeTokens(generic);
		} catch (err) {
			throw readStructureError(err, path);
		}

		const f = new Fields(generic);
		try {
			this.definition = readDefinition(f);
			this.model = f.string("model");
			this.exceptions = f.strings("exceptions");
			this.ignorecase = f.bool("ignorecase");
			f.ignore("tokens");
			f.done();
		} catch (err) {
			throw readStructureError(err, path);
		}

		checkScopes(this.definition.scope, path);

		for (const token of this.tokens) {
			if (token.upos !== "") {
				if (token.tag !== "") {
					throw newE201FromPosition(
						"a token cannot set both `tag` and `upos`",
						path,
						1,
					);
				}

				try {
					token.tag = uposTagPattern(token.upos);
				} catch (err) {
					throw newE201FromPosition(
						err instanceof Error ? err.message : String(err),
						path,
						1,
					);
				}

				// A category Penn cannot express on its own also constrains the
				// word. Only applied when the rule did not ask for a pattern of
				// its own, which is the more specific request.
				if (token.pattern === "") {
					const words = uposWordPattern(token.upos);
					if (words !== "") {
						try {
							token.wordRe = Regexp.compile(words);
						} catch (err) {
							throw newE201FromPosition(
								err instanceof Error ? err.message : String(err),
								path,
								1,
							);
						}
					}
				}
			}

			if (!this.needsTagging && token.tag !== "") this.needsTagging = true;

			if (token.tag !== "") {
				try {
					token.tagRe = Regexp.compile(token.tag);
				} catch (err) {
					throw patternError(err, path, token.tag);
				}
			}

			if (token.pattern !== "") {
				const template = makeRegexp(
					cfg?.wordTemplate ?? "",
					this.ignorecase,
					() => false,
					() => "",
					false,
				);
				try {
					token.re = Regexp.compile(fillTemplate(template, token.pattern));
				} catch (err) {
					throw patternError(err, path, token.pattern);
				}

				let anchored = fillTemplate(TOKEN_TEMPLATE, token.pattern);
				if (this.ignorecase) anchored = IGNORE_CASE + anchored;

				try {
					token.tokenRe = Regexp.compile(anchored);
				} catch (err) {
					throw patternError(err, path, token.pattern);
				}
			}
		}

		// A model is a dictionary asset, resolved and loaded the same way a
		// spelling dictionary is. Doing it here means an unreadable one is
		// reported when the style loads rather than on the first sentence.
		if (this.model !== "") {
			const asset =
				cfg === null ? "" : findConfigAsset(cfg, `${this.model}.dict`, DICT_DIR);
			if (asset === "") {
				throw newE201FromTarget(
					`model "${this.model}" not found in ${DICT_DIR}`,
					this.model,
					path,
				);
			}
			try {
				registerModel(this.model, asset);
			} catch (err) {
				throw newE201FromTarget(
					err instanceof Error ? err.message : String(err),
					this.model,
					path,
				);
			}
		}

		for (const pattern of this.exceptions) {
			try {
				this.exceptRe.push(Regexp.compile(pattern));
			} catch (err) {
				throw patternError(err, path, pattern);
			}
		}

		this.definition.scope = sentenceScope(this.definition.scope);
		this.filter = this.literals();
	}

	/**
	 * Expands `tokens` into one entry per position the walk has to consider:
	 * a `skip` window's spare positions, then the token itself.
	 */
	private makeTokens(generic: BaseCheck): void {
		const declared = generic.tokens;
		if (!Array.isArray(declared)) {
			throw new Error("'tokens' is a list of token definitions");
		}

		let group = 0;
		for (const raw of declared) {
			const tok = newNLPToken();
			if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
				const f = new Fields(raw as BaseCheck);
				// Read without refusing an unknown key, as Go's `WeakDecode`
				// does for a token.
				tok.pattern = f.string("pattern");
				tok.tag = f.string("tag");
				tok.skip = f.int("skip");
				tok.min = f.int("min");
				tok.upos = f.string("upos");
				tok.target = f.bool("target");
				tok.negate = f.bool("negate");
			} else {
				throw new Error("a token is a mapping of keys to values");
			}

			const reps = tok.min < 1 ? 1 : tok.min;

			for (let r = 0; r < reps; r++) {
				group++;
				tok.group = group;

				tok.optional = true;
				tok.end = false;
				for (let i = tok.skip; i > 0; i--) {
					tok.start = i === tok.skip;
					this.tokens.push({ ...tok });
				}

				if (tok.pattern !== "" || tok.tag !== "" || tok.upos !== "") {
					tok.optional = false;
					tok.start = false;
					tok.end = true;
					this.tokens.push({ ...tok });
				}
			}
		}
	}

	/** The spans of every exception region in `txt`. */
	private exceptionSpans(txt: string): Array<[number, number]> {
		const spans: Array<[number, number]> = [];
		for (const re of this.exceptRe) {
			for (const loc of re.findAllStringIndex(txt, -1)) {
				const [lo, hi, ok] = runeSpanToBytes(txt, loc[0], loc[1]);
				if (ok) spans.push([lo, hi]);
			}
		}
		return spans;
	}

	/** The strongest literal requirement any single token provides. */
	private literals(): string[] {
		let best: string[] = [];
		for (const token of this.tokens) {
			const pat = token.pattern;
			if (pat === "" || token.negate || token.skip > 0) {
				// A negated token requires the *absence* of something, and a
				// skipped one is optional. Neither guarantees any text.
				continue;
			}
			const got = Required(pat);
			if (got.length > 0 && weight(got) > weight(best)) best = got;
		}
		return best;
	}

	run(blk: Block, file: File | null, cfg: Config | null): Alert[] {
		const alerts: Alert[] = [];
		let offset: string[] = [];
		const history: number[] = [];

		// Rule the sequence out before tagging, which is the expensive part.
		if (this.filter.length > 0 && !containsAny(blk.lower, this.filter)) {
			return alerts;
		}

		// This is *always* sentence-scoped.
		const words = tokensWith(file, this.model, blk.text);

		// A remote NLP endpoint returns text and tags only, so there are no
		// offsets to work from and the match has to be located by its text.
		const positioned = (file?.nlp.endpoint ?? "") === "";

		const txt = blk.text;
		const excluded = this.exceptionSpans(txt);

		const anchorAt = this.anchor();
		if (anchorAt === null) return alerts;
		const [idx, tok] = anchorAt;

		// Each candidate position for the anchor is one possible violation. A
		// `pattern` anchor enumerates them by searching the text; a tag-only
		// anchor has nothing to search for, so the walk stops when it runs out.
		for (const loc of this.candidates(txt, tok, words.length)) {
			const m = sequenceMatches(idx, this, tok, words, history);
			history.push(m.index);

			if (matchOK(m)) {
				const located = this.locate(txt, words, m, positioned);
				if (located === null) {
					// Matched but cannot say where; reporting a bogus span is
					// worse than reporting nothing.
					continue;
				}
				let [span, seq] = located;

				if (beginsInside(excluded, span[0])) continue;

				// When the block knows where it sits in the document, hand back
				// an absolute offset. Otherwise the span is block-relative and
				// has to be located by searching, which resolves every repeat
				// of a sentence to the first one.
				const absolute = blk.offset >= 0;
				if (absolute) span = [blk.offset + span[0], blk.offset + span[1]];

				const action = {
					name: this.definition.action.name,
					params: [...this.definition.action.params],
				};
				if (this.definition.matchCase && action.name === "replace") {
					action.params = recase(action.params, seq);
				}

				const a: Alert = {
					action,
					suggestions: [],
					check: this.definition.name,
					severity: this.definition.level,
					link: this.definition.link,
					span,
					hide: false,
					hasByteOffsets: absolute,
					match: seq,
					description: "",
					message: "",
					line: 0,
				};

				[a.message, a.description] = formatMessages(
					this.definition.message,
					this.definition.description,
					...m.text,
				);
				a.offset = offset;

				resolveFix(a, cfg);

				alerts.push(a);
				offset = [];
			} else if (loc !== null) {
				offset.push(re2Loc(blk, loc));
			}
		}

		return alerts;
	}

	/**
	 * The token the search starts from.
	 *
	 * A `pattern` token is preferred because it can be located in the text
	 * directly. Failing that any tagged token will do -- without this, a rule
	 * made only of tags matched nothing at all, silently.
	 */
	anchor(): [number, NLPToken] | null {
		for (let i = 0; i < this.tokens.length; i++) {
			const tok = this.tokens[i]!;
			if (!tok.negate && tok.pattern !== "") return [i, tok];
		}
		for (let i = 0; i < this.tokens.length; i++) {
			const tok = this.tokens[i]!;
			if (!tok.negate && tok.tag !== "") return [i, tok];
		}
		return null;
	}

	/**
	 * One entry per position the anchor might occupy.
	 *
	 * For a `pattern` anchor each entry is the match's location in the text,
	 * which the caller reports as an offset when the surrounding sequence does
	 * not pan out. A tag-only anchor has no such location, so the entries are
	 * null and the count simply bounds how many times to try.
	 */
	private candidates(
		txt: string,
		tok: NLPToken,
		words: number,
	): Array<[number, number] | null> {
		if (tok.re !== null) return tok.re.findAllStringIndex(txt, -1);
		return new Array<null>(words).fill(null);
	}

	/**
	 * The span of a match within `txt`, plus the matched text.
	 *
	 * When the tokens carry offsets, the span is taken straight from them, so
	 * it is exact even when the sequence occurs more than once or the source
	 * spacing is irregular. Without offsets the text is rebuilt and searched
	 * for, which is what Vale did before tokens had positions; that path
	 * returns null rather than a negative span when the search fails.
	 */
	private locate(
		txt: string,
		words: readonly Token[],
		m: SequenceMatch,
		positioned: boolean,
	): [[number, number], string] | null {
		if (positioned && m.hi < words.length) {
			let lo = m.lo;
			let hi = m.hi;
			const narrowed = this.targetRange(m);
			if (narrowed !== null) [lo, hi] = narrowed;

			const start = words[lo]!.start;
			const end = words[hi]!.start + words[hi]!.text.length;
			if (start >= 0 && end <= txt.length && start < end) {
				return [[start, end], txt.slice(start, end)];
			}
		}

		const seq = stepsToString(m.text);
		const ssp = txt.indexOf(seq);
		if (ssp >= 0) return [[ssp, ssp + seq.length], seq];
		return null;
	}

	/**
	 * The span of words covered by the rule's `target` tokens.
	 *
	 * Several tokens may be marked, in which case the range runs from the first
	 * to the last -- a target of two words reports both, not just one.
	 * Unmarked tokens between them are included, since the result has to be a
	 * single contiguous span.
	 */
	private targetRange(m: SequenceMatch): [number, number] | null {
		let lo = -1;
		let hi = -1;
		for (let i = 0; i < this.tokens.length; i++) {
			if (!this.tokens[i]!.target) continue;
			const w = m.wordAt.get(i);
			if (w === undefined) {
				// A targeted token that matched nothing -- an optional or
				// skipped one. Narrowing to a range that cannot be fully
				// resolved would report the wrong span, so fall back to the
				// whole match.
				return null;
			}
			if (lo < 0 || w < lo) lo = w;
			if (w > hi) hi = w;
		}
		if (lo < 0) return null;
		return [lo, hi];
	}

	fields(): Definition {
		return this.definition;
	}

	pattern(): string {
		return "";
	}
}

/** Whether `pos` falls within any of the given spans. */
function beginsInside(
	spans: ReadonlyArray<readonly [number, number]>,
	pos: number,
): boolean {
	for (const span of spans) {
		if (pos >= span[0] && pos < span[1]) return true;
	}
	return false;
}

/**
 * Whether every remaining token is negated.
 *
 * A negated token asserts the absence of something, and at the edge of the
 * sentence there is no word at all, so the assertion holds vacuously. This is
 * what lets a rule require "not preceded by X" without also demanding that
 * something precede the match.
 */
function negatedToBoundary(toks: readonly NLPToken[]): boolean {
	return toks.every((tok) => tok.negate);
}

export function tokensMatch(token: NLPToken, word: Token): boolean {
	let failedTag = token.tagRe === null || token.tagRe.test(word.tag);
	failedTag = failedTag === token.negate;
	const failedTok =
		token.tokenRe !== null && token.tokenRe.test(word.text) === token.negate;

	// A universal tag that Penn cannot express also restricts which words
	// qualify -- `upos: AUX` is "a verb, and one of these words".
	if (token.wordRe !== null && token.wordRe.test(word.text) === token.negate) {
		return false;
	}

	if (
		(token.pattern === "" && failedTag) ||
		(token.tag === "" && failedTok) ||
		(token.tag !== "" && token.pattern !== "" && (failedTag || failedTok))
	) {
		return false;
	}

	return true;
}

/**
 * One sequence hit: the matched words' text, the index of the anchor word, and
 * the range of word indices the match covers.
 *
 * The index range is what lets `run` report where the match actually is. The
 * text alone is not enough: the same sequence can occur more than once, and
 * re-joining the words does not reproduce the source when the spacing is
 * irregular.
 */
interface SequenceMatch {
	text: string[];
	index: number;
	lo: number;
	hi: number;

	/**
	 * Maps a position in the expanded token list to the word it matched, so a
	 * targeted token can be resolved back to its span.
	 */
	wordAt: Map<number, number>;
}

function matchOK(m: SequenceMatch): boolean {
	return m.text.length > 0 && m.lo >= 0 && m.hi >= m.lo;
}

export function sequenceMatches(
	idx: number,
	chk: Sequence,
	target: NLPToken,
	words: readonly Token[],
	history: readonly number[],
): SequenceMatch {
	let text: string[] = [];

	const toks = chk.tokens;
	const sizeT = toks.length;
	const sizeW = words.length;
	let index = 0;
	let lo = -1;
	let hi = -1;
	const wordAt = new Map<number, number>();

	const failed = (): SequenceMatch => ({
		text: [],
		index,
		lo: -1,
		hi: -1,
		wordAt,
	});

	for (let jdx = 0; jdx < words.length; jdx++) {
		const tok0 = words[jdx]!;
		if (!tokensMatch(target, tok0) || intInSlice(jdx, history)) continue;

		index = jdx;
		// The context is found. The *first* token with a `pattern` becomes the
		// anchor of the search; from there both sides have to be checked.
		if (idx > 0) {
			// The left-hand side. With the anchor first there is none.
			let ti = idx - 1;
			let wi = jdx - 1;
			while (ti >= 0) {
				if (wi < 0) {
					if (negatedToBoundary(toks.slice(0, ti + 1))) break;
					return failed();
				}
				const tok = { ...toks[ti]! };
				const word = words[wi]!;
				text = [word.text, ...text];
				lo = wi;
				wordAt.set(ti, wi);

				// The token list is built with the right-hand orientation in
				// mind: `optional (start), optional, required (end)` reads as
				// `required, optional, optional` from right to left.
				if (tok.skip > 0) {
					tok.optional = (tok.optional || tok.end) && !tok.start;
				}

				const mat = tokensMatch(tok, word);
				if (!mat && !tok.optional) return failed();
				if (mat && tok.optional) {
					// The token was found inside its window: the group's spare
					// positions are done with, but the tokens past them still
					// have to hold.
					while (ti >= 0 && toks[ti]!.group === tok.group) ti--;
					wi--;
				} else {
					ti--;
					wi--;
				}
			}
		}
		if (idx < sizeT) {
			// The right-hand side. With the anchor last there is none.
			let ti = idx;
			let wi = jdx;
			while (ti < sizeT) {
				if (wi >= sizeW) {
					if (negatedToBoundary(toks.slice(ti))) break;
					return failed();
				}
				const tok = toks[ti]!;
				const word = words[wi]!;
				text = [...text, word.text];
				if (lo < 0 || wi < lo) lo = wi;
				hi = wi;
				wordAt.set(ti, wi);

				const mat = tokensMatch(tok, word);
				if (!mat && !tok.optional) return failed();
				if (mat && tok.optional) {
					while (ti < sizeT && toks[ti]!.group === tok.group) ti++;
					wi++;
				} else {
					ti++;
					wi++;
				}
			}
		}
		break;
	}

	return { text, index, lo, hi, wordAt };
}

/** Re-joins a match's words, spacing them the way English is written. */
export function stepsToString(steps: readonly string[]): string {
	let sb = "";

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i]!;
		if (
			step === "." ||
			step === "," ||
			step === ":" ||
			step === ";" ||
			step === "!" ||
			step === "?" ||
			step === "'" ||
			step === '"' ||
			step === ")"
		) {
			// No space before punctuation or a closing parenthesis.
			sb += step;
		} else if (step === "(") {
			// No space before or after an opening parenthesis.
			if (i > 0 && sb.length > 0 && sb[sb.length - 1] !== " ") sb += " ";
			sb += step;
		} else if (step.startsWith("'")) {
			// An apostrophe attaches to the word before it.
			sb += step;
		} else {
			if (sb.length > 0) sb += " ";
			sb += step;
		}
	}

	return sb.trim();
}

/**
 * Narrows the scopes a `sequence` rule was given to the sentences within them.
 *
 * The rule reads part-of-speech data, which is tagged a sentence at a time, so
 * it always runs on sentences -- but *which* sentences is the author's to say.
 * Declaring `list` means the sentences of list items, not the whole document's.
 * An undeclared scope means all of them.
 */
export function sentenceScope(declared: readonly string[]): string[] {
	if (declared.length === 0) return ["sentence"];

	const scopes: string[] = [];
	for (const s of declared) {
		if (s === "sentence" || s.startsWith("sentence.")) {
			scopes.push(s);
			continue;
		}
		// A bare negated term names only what to exclude and never mentions
		// `sentence` itself, so `asksForSentence` skips every `sentence.*`
		// fragment block for it and the rule matched the whole unsegmented
		// block instead -- narrowing to `~list` alone was a no-op. AND-ing
		// `sentence` in front keeps the exclusion and still narrows:
		// `sentence&~list` is "sentences outside a list".
		if (s.startsWith("~")) {
			scopes.push(`sentence&${s}`);
			continue;
		}
		// `paragraph` names no block of its own. Splitting wraps every block as
		// `paragraph.<scope>` -- headings and list items included -- so the
		// scope already describes the same blocks an undeclared one does.
		// Narrowing it to `sentence.paragraph` asked for blocks that are never
		// built, and the rule matched nothing without saying so.
		if (s === "paragraph" || s.startsWith("paragraph.")) {
			scopes.push(`sentence${s.slice("paragraph".length)}`);
			continue;
		}
		scopes.push(`sentence & ${s}`);
	}

	return scopes;
}

/** Whether `lowered` holds any of the literals. */
function containsAny(lowered: string, lits: readonly string[]): boolean {
	for (const l of lits) {
		if (lowered.includes(l)) return true;
	}
	return false;
}
