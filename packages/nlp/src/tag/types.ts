/**
 * What every tagger here satisfies.
 *
 * More than one exists because they disagree in ways that matter to the caller
 * rather than in ways one of them is simply better at. The perceptron reads
 * context and is the more accurate on ordinary prose; a dictionary-driven
 * tagger is steadier on text that is already ungrammatical, which is where a
 * grammar checker does its work. A rule written against one of them expects
 * that one's answers, so the choice belongs to the caller.
 */

import type { Token } from "../token.ts";

export type { Token };

export interface Tagging {
	/**
	 * Assigns a tag to each word and returns the tagged tokens.
	 *
	 * The input is treated as one sentence.
	 */
	tag(words: string[]): Token[];

	/**
	 * Fills in the `tag` field of each token, using its `text`. This writes
	 * into the caller's array rather than returning a new one.
	 */
	tagTokens(tokens: Token[]): void;

	/** Which tagger this is, as registered. */
	name(): string;
}

/** Builds a tagger. Registered rather than constructed directly so a caller can name one in configuration. */
export type Factory = () => Tagging;
