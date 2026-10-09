/**
 * Finding comments without a grammar.
 *
 * Clojure, PowerShell, Haskell, Julia and Protocol Buffers have no usable
 * tree-sitter grammar in this build (see `lang.ts`), so their comments are
 * found by their delimiters: a line comment runs from its marker to the end of
 * the line, and a block comment from its opener to the first closer.
 *
 * That is all this does differently. The text is handed to the same
 * `CommentBuilder` a captured node goes through, so a comment found here is
 * dedented, scoped and placed exactly as one found by a query -- and the
 * markup a view maps onto the file works the same way. The one thing a
 * delimiter cannot know is context: a `#` inside a string is read as a
 * comment, which is the price of having no parser.
 */

import { CommentBuilder } from "./query.ts";
import type { Comment, Language } from "./types.ts";

/** The comments of `source`, found by `lang`'s delimiters. */
export function scanComments(source: string, lang: Language): Comment[] {
	const delims = lang.scanner;
	if (delims === null) return [];

	const builder = new CommentBuilder(lang);
	const found: Comment[] = [];
	const lines = source.split("\n");

	let block: string[] | null = null;
	let blockRow = 0;
	let blockCol = 0;

	const emit = (text: string, row: number, col: number): void => {
		found.push(builder.build(text, row, col, "", lang.queries[0]?.type ?? "", ""));
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (block !== null) {
			const end = delims.blockEnd.exec(line);
			if (end === null) {
				block.push(line);
				continue;
			}
			block.push(line.slice(0, end.index + end[0].length));
			emit(block.join("\n"), blockRow, blockCol);
			block = null;
			continue;
		}

		const start = delims.blockStart.exec(line);
		const inline = delims.inline.exec(line);

		// Whichever opens first on the line wins: `# a note` is a line comment
		// even in a language whose block opener also begins with `#`.
		if (start !== null && (inline === null || start.index <= inline.index)) {
			const after = line.slice(start.index + start[0].length);
			const end = delims.blockEnd.exec(after);
			if (end !== null) {
				// Opened and closed on one line.
				const stop =
					start.index + start[0].length + end.index + end[0].length;
				emit(line.slice(start.index, stop), i, start.index);
				continue;
			}
			block = [line.slice(start.index)];
			blockRow = i;
			blockCol = start.index;
			continue;
		}

		if (inline !== null) {
			emit(inline[0], i, inline.index);
		}
	}

	// A block comment the file never closes still holds prose; reading it to
	// the end of the file is what a reader does.
	if (block !== null) emit(block.join("\n"), blockRow, blockCol);

	return found;
}
