/**
 * `vale tag`: a file's words with the part-of-speech tag each one carries.
 *
 * This is the surface the editor integrations call to show what a `sequence`
 * rule is matching against.
 *
 * Where Go differs: it strips Markdown from each line first, through an
 * unexported helper in `internal/core`. There is no equivalent in
 * `@vale-ts/core`, so this tags the line as written. The tags are the same for
 * prose; a line that is mostly markup produces tags for the markup too.
 */

import { substitute } from "@vale-ts/core";
import { type Info, textToTokens } from "@vale-ts/nlp";

/** A word with its NLP context, as the JSON output carries it. */
export interface TaggedWord {
	Token: { Text: string; Tag: string };
	Line: number;
	Span: number[];
}

/** The quote tags, which carry no word of their own. */
const QUOTE_TAGS = ["''", "``"];

/** Tags every word of `text`, placing each one by line and column. */
export function textToContext(text: string, meta: Info): TaggedWord[] {
	const context: TaggedWord[] = [];

	text.split("\n").forEach((original, idx) => {
		let line = original;
		let pos = 0;

		for (const tok of textToTokens(line, meta)) {
			if (tok.text.trim() === "") continue;

			const found = line.slice(pos).indexOf(tok.text);
			const s = found < 0 ? pos : found + pos;

			if (!QUOTE_TAGS.includes(tok.tag)) {
				context.push({
					Token: { Text: tok.text, Tag: tok.tag },
					Line: idx + 1,
					Span: [s + 1, s + tok.text.length],
				});
			}

			pos = s;
			[line] = substitute(line, tok.text, "*");
		}
	});

	return context;
}
