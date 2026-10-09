/**
 * An HTML tokenizer with the behavior Vale's walker was written against.
 *
 * Vale reads HTML as a stream of tokens rather than as a tree, because what it
 * needs from a document is the order its text arrives in and the tags open
 * around each piece. A tree would have to be flattened back into that, and the
 * flattening is where the position information gets lost.
 *
 * This matches `golang.org/x/net/html`'s tokenizer on the points the walker
 * depends on: the token types, lower-cased tag names, attribute values decoded
 * once, text decoded once with its surrounding whitespace intact, raw-text
 * elements whose contents arrive as a single text token, and a self-closing
 * tag reported as its own kind.
 */

import { decodeHTML } from "entities";

export enum TokenType {
	/** The input ended, or could not be read any further. */
	Error = 0,
	Text = 1,
	StartTag = 2,
	EndTag = 3,
	SelfClosingTag = 4,
	Comment = 5,
	Doctype = 6,
}

export interface Attribute {
	key: string;
	val: string;
}

export interface Token {
	type: TokenType;
	/** The tag name for a tag, or the decoded text for anything else. */
	data: string;
	attr: Attribute[];
}

/**
 * The elements whose contents are not markup.
 *
 * Everything between the start and end tag arrives as one text token, which is
 * what keeps a `<script>` holding a `<` from being read as a tag. The same list
 * `x/net/html` uses, so that a document tokenizes the same way under both.
 */
const RAW_TEXT_TAGS = new Set([
	"iframe",
	"noembed",
	"noframes",
	"noscript",
	"plaintext",
	"script",
	"style",
	"textarea",
	"title",
	"xmp",
]);

const WHITESPACE = " \t\n\r\f";

export class Tokenizer {
	private readonly src: string;
	private pos = 0;

	private type = TokenType.Error;
	private data = "";
	private attrs: Attribute[] = [];

	/** The tag whose raw contents come next, or "". */
	private rawTag = "";

	constructor(src: string) {
		this.src = src;
	}

	/** Advances to the next token and returns its type. */
	next(): TokenType {
		this.attrs = [];
		this.data = "";

		if (this.pos >= this.src.length) {
			this.type = TokenType.Error;
			return this.type;
		}

		if (this.rawTag !== "") {
			return this.readRawText();
		}

		if (this.src[this.pos] === "<") {
			const after = this.src[this.pos + 1] ?? "";
			if (after === "!") return this.readMarkupDeclaration();
			if (after === "/") return this.readEndTag();
			if (/[A-Za-z]/.test(after)) return this.readStartTag();
			// A `<` that opens nothing is text, as the spec says.
		}

		return this.readText();
	}

	/** The token the last `next` reached. */
	token(): Token {
		return { type: this.type, data: this.data, attr: this.attrs };
	}

	// --- text ---------------------------------------------------------------

	private readText(): TokenType {
		const start = this.pos;
		let i = this.pos + 1;
		for (;;) {
			i = this.src.indexOf("<", i);
			if (i < 0) {
				i = this.src.length;
				break;
			}
			const after = this.src[i + 1] ?? "";
			if (after === "!" || after === "/" || /[A-Za-z]/.test(after)) break;
			i++;
		}
		this.pos = i;
		this.type = TokenType.Text;
		this.data = decodeHTML(this.src.slice(start, i));
		return this.type;
	}

	/**
	 * Reads the contents of a raw-text element, up to its end tag.
	 *
	 * The end tag is matched case-insensitively and must be followed by
	 * whitespace, `/` or `>`, so a `</scriptable>` inside a `<script>` does not
	 * close it.
	 */
	private readRawText(): TokenType {
		const tag = this.rawTag;
		this.rawTag = "";

		const start = this.pos;
		const lower = this.src.toLowerCase();
		let at = this.pos;
		for (;;) {
			at = lower.indexOf(`</${tag}`, at);
			if (at < 0) {
				this.pos = this.src.length;
				this.type = TokenType.Text;
				this.data = this.src.slice(start);
				return this.type;
			}
			const after = this.src[at + tag.length + 2] ?? ">";
			if (WHITESPACE.includes(after) || after === "/" || after === ">") break;
			at += 2;
		}

		if (at === start) {
			// The element is empty, so the end tag is the next token.
			return this.next();
		}

		this.pos = at;
		this.type = TokenType.Text;
		// Raw text is not decoded: a `&amp;` in a script is a `&amp;`.
		this.data = this.src.slice(start, at);
		return this.type;
	}

	// --- declarations -------------------------------------------------------

	private readMarkupDeclaration(): TokenType {
		if (this.src.startsWith("<!--", this.pos)) {
			const start = this.pos + 4;
			let end = this.src.indexOf("-->", start);
			let next: number;
			if (end < 0) {
				end = this.src.length;
				next = end;
			} else {
				next = end + 3;
			}
			this.pos = next;
			this.type = TokenType.Comment;
			this.data = decodeHTML(this.src.slice(start, end));
			return this.type;
		}

		// A doctype, a CDATA section, or a bogus comment: everything up to the
		// next `>`.
		const start = this.pos + 2;
		let end = this.src.indexOf(">", start);
		if (end < 0) end = this.src.length;
		this.pos = Math.min(end + 1, this.src.length);
		this.type = TokenType.Doctype;
		this.data = decodeHTML(this.src.slice(start, end));
		return this.type;
	}

	// --- tags ---------------------------------------------------------------

	private readEndTag(): TokenType {
		let i = this.pos + 2;
		const nameStart = i;
		while (
			i < this.src.length &&
			!WHITESPACE.includes(this.src[i]!) &&
			this.src[i] !== ">"
		) {
			i++;
		}
		const name = this.src.slice(nameStart, i).toLowerCase();

		// Anything between the name and the `>` is discarded, as the spec says.
		const end = this.src.indexOf(">", i);
		this.pos = end < 0 ? this.src.length : end + 1;

		this.type = TokenType.EndTag;
		this.data = name;
		return this.type;
	}

	private readStartTag(): TokenType {
		let i = this.pos + 1;
		const nameStart = i;
		while (
			i < this.src.length &&
			!WHITESPACE.includes(this.src[i]!) &&
			this.src[i] !== ">" &&
			this.src[i] !== "/"
		) {
			i++;
		}
		const name = this.src.slice(nameStart, i).toLowerCase();

		const attrs: Attribute[] = [];
		let selfClosing = false;

		for (;;) {
			while (i < this.src.length && WHITESPACE.includes(this.src[i]!)) i++;
			if (i >= this.src.length) break;

			if (this.src[i] === ">") {
				i++;
				break;
			}
			if (this.src[i] === "/") {
				i++;
				if (this.src[i] === ">") {
					selfClosing = true;
					i++;
					break;
				}
				continue;
			}

			// An attribute name runs to whitespace, `=`, `/` or `>`.
			const keyStart = i;
			while (
				i < this.src.length &&
				!WHITESPACE.includes(this.src[i]!) &&
				this.src[i] !== "=" &&
				this.src[i] !== ">" &&
				this.src[i] !== "/"
			) {
				i++;
			}
			const key = this.src.slice(keyStart, i).toLowerCase();

			while (i < this.src.length && WHITESPACE.includes(this.src[i]!)) i++;

			let val = "";
			if (this.src[i] === "=") {
				i++;
				while (i < this.src.length && WHITESPACE.includes(this.src[i]!)) i++;
				const quote = this.src[i];
				if (quote === '"' || quote === "'") {
					i++;
					const valStart = i;
					const close = this.src.indexOf(quote, i);
					const end = close < 0 ? this.src.length : close;
					val = this.src.slice(valStart, end);
					i = close < 0 ? this.src.length : close + 1;
				} else {
					const valStart = i;
					while (
						i < this.src.length &&
						!WHITESPACE.includes(this.src[i]!) &&
						this.src[i] !== ">"
					) {
						i++;
					}
					val = this.src.slice(valStart, i);
				}
			}

			if (key !== "") attrs.push({ key, val: decodeHTML(val) });
		}

		this.pos = i;
		this.type = selfClosing ? TokenType.SelfClosingTag : TokenType.StartTag;
		this.data = name;
		this.attrs = attrs;

		if (!selfClosing && RAW_TEXT_TAGS.has(name)) this.rawTag = name;

		return this.type;
	}
}

/** The value of `key` on `tok`, or "". */
export function getAttribute(tok: Token, key: string): string {
	for (const attr of tok.attr) {
		if (attr.key === key) return attr.val;
	}
	return "";
}

/** Decodes HTML entities, as the walker does to a token's text. */
export function unescapeEntities(s: string): string {
	return decodeHTML(s);
}
