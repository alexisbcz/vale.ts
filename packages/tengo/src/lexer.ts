/**
 * The scanner, following Tengo's own -- which follows Go's.
 *
 * The one part worth calling out is semicolon insertion. Tengo has no
 * statement terminator in its source, so the scanner inserts one before a
 * newline whenever the previous token could end a statement: an identifier, a
 * literal, `break`/`continue`/`return`/`export`/`true`/`false`/`undefined`,
 * `++`/`--`, or a closing `)`, `]` or `}`. Everything the parser does with
 * statement boundaries rests on that, so the rule is reproduced here exactly,
 * including the case where a comment stands in for the newline it swallowed.
 */

import { TengoError } from "./values.ts";

export type TokenKind =
	| "eof"
	| "ident"
	| "int"
	| "float"
	| "char"
	| "string"
	// operators and punctuation, spelled as they are written
	| "+"
	| "-"
	| "*"
	| "/"
	| "%"
	| "&"
	| "|"
	| "^"
	| "<<"
	| ">>"
	| "&^"
	| "+="
	| "-="
	| "*="
	| "/="
	| "%="
	| "&="
	| "|="
	| "^="
	| "<<="
	| ">>="
	| "&^="
	| "&&"
	| "||"
	| "++"
	| "--"
	| "=="
	| "<"
	| ">"
	| "="
	| "!"
	| "!="
	| "<="
	| ">="
	| ":="
	| "..."
	| "("
	| "["
	| "{"
	| ","
	| "."
	| ")"
	| "]"
	| "}"
	| ";"
	| ":"
	| "?"
	// keywords
	| "break"
	| "continue"
	| "else"
	| "for"
	| "func"
	| "error"
	| "immutable"
	| "if"
	| "return"
	| "export"
	| "true"
	| "false"
	| "in"
	| "undefined"
	| "import";

export interface Token {
	kind: TokenKind;
	/** The source text of the token; `"\n"` for an inserted semicolon. */
	text: string;
	/** The value of an `int`, `float` or `char` token. */
	num: number;
	/** The decoded value of a `string` token. */
	str: string;
	/** Where the token starts, as an offset into the source. */
	at: number;
}

const KEYWORDS = new Set<TokenKind>([
	"break",
	"continue",
	"else",
	"for",
	"func",
	"error",
	"immutable",
	"if",
	"return",
	"export",
	"true",
	"false",
	"in",
	"undefined",
	"import",
]);

/** Keywords after which a newline closes a statement. */
const ENDS_STATEMENT = new Set<TokenKind>([
	"ident",
	"int",
	"float",
	"char",
	"string",
	"break",
	"continue",
	"return",
	"export",
	"true",
	"false",
	"undefined",
	"++",
	"--",
	")",
	"]",
	"}",
]);

export function tokenize(source: string): Token[] {
	return new Lexer(source).all();
}

class Lexer {
	private readonly src: string;
	private pos = 0;
	/** Whether a newline from here on closes a statement. */
	private insertSemi = false;

	constructor(src: string) {
		this.src = src;
	}

	all(): Token[] {
		const out: Token[] = [];
		for (;;) {
			const tok = this.scan();
			out.push(tok);
			if (tok.kind === "eof") return out;
		}
	}

	private fail(message: string, at = this.pos): never {
		let line = 1;
		for (let i = 0; i < at && i < this.src.length; i++) {
			if (this.src[i] === "\n") line++;
		}
		throw new TengoError(`${line}: ${message}`);
	}

	private make(kind: TokenKind, at: number, text: string = kind): Token {
		return { kind, text, num: 0, str: "", at };
	}

	private peek(ahead = 0): string {
		return this.src[this.pos + ahead] ?? "";
	}

	private scan(): Token {
		for (;;) {
			this.skipSpace();
			const at = this.pos;

			if (this.pos >= this.src.length) {
				if (this.insertSemi) {
					this.insertSemi = false;
					return { kind: ";", text: "\n", num: 0, str: "", at };
				}
				return this.make("eof", at, "");
			}

			const ch = this.peek();

			if (ch === "\n") {
				// Only reachable while insertSemi holds; skipSpace eats the
				// rest.
				this.pos++;
				this.insertSemi = false;
				return { kind: ";", text: "\n", num: 0, str: "", at };
			}

			if (ch === "/" && (this.peek(1) === "/" || this.peek(1) === "*")) {
				// A comment that spans a line end stands in for that line end.
				if (this.insertSemi && this.commentEndsLine()) {
					this.insertSemi = false;
					return { kind: ";", text: "\n", num: 0, str: "", at };
				}
				this.skipComment();
				continue;
			}

			const tok = this.scanToken(at, ch);
			this.insertSemi = ENDS_STATEMENT.has(tok.kind);
			return tok;
		}
	}

	private scanToken(at: number, ch: string): Token {
		if (isLetter(ch)) {
			while (this.pos < this.src.length && isAlnum(this.peek())) this.pos++;
			const text = this.src.slice(at, this.pos);
			const kind = KEYWORDS.has(text as TokenKind) ? (text as TokenKind) : "ident";
			return { kind, text, num: 0, str: "", at };
		}

		if (isDigit(ch) || (ch === "." && isDigit(this.peek(1)))) {
			return this.scanNumber(at);
		}

		switch (ch) {
			case '"':
				return this.scanString(at);
			case "`":
				return this.scanRawString(at);
			case "'":
				return this.scanChar(at);
		}

		this.pos++;
		switch (ch) {
			case ":":
				return this.switch2(at, ":", ":=", "=");
			case ".":
				if (this.peek() === "." && this.peek(1) === ".") {
					this.pos += 2;
					return this.make("...", at);
				}
				return this.make(".", at);
			case ",":
			case "?":
			case "(":
			case ")":
			case "[":
			case "]":
			case "{":
			case "}":
				return this.make(ch as TokenKind, at);
			case ";":
				return { kind: ";", text: ";", num: 0, str: "", at };
			case "+":
				return this.switch3(at, "+", "+=", "=", "++", "+");
			case "-":
				return this.switch3(at, "-", "-=", "=", "--", "-");
			case "*":
				return this.switch2(at, "*", "*=", "=");
			case "/":
				return this.switch2(at, "/", "/=", "=");
			case "%":
				return this.switch2(at, "%", "%=", "=");
			case "^":
				return this.switch2(at, "^", "^=", "=");
			case "=":
				return this.switch2(at, "=", "==", "=");
			case "!":
				return this.switch2(at, "!", "!=", "=");
			case "<":
				return this.switch4(at, "<", "<=", "<<", "<<=");
			case ">":
				return this.switch4(at, ">", ">=", ">>", ">>=");
			case "&":
				if (this.peek() === "^") {
					this.pos++;
					return this.switch2(at, "&^", "&^=", "=");
				}
				return this.switch3(at, "&", "&=", "=", "&&", "&");
			case "|":
				return this.switch3(at, "|", "|=", "=", "||", "|");
		}

		this.fail(`illegal character ${JSON.stringify(ch)}`, at);
	}

	/** `tok`, or `two` when the next character is `second`. */
	private switch2(
		at: number,
		tok: TokenKind,
		two: TokenKind,
		second: string,
	): Token {
		if (this.peek() === second) {
			this.pos++;
			return this.make(two, at);
		}
		return this.make(tok, at);
	}

	/** `switch2`, plus a doubled form such as `++`. */
	private switch3(
		at: number,
		tok: TokenKind,
		two: TokenKind,
		second: string,
		doubled: TokenKind,
		repeat: string,
	): Token {
		if (this.peek() === second) {
			this.pos++;
			return this.make(two, at);
		}
		if (this.peek() === repeat) {
			this.pos++;
			return this.make(doubled, at);
		}
		return this.make(tok, at);
	}

	/** The shift family: `<`, `<=`, `<<`, `<<=`. */
	private switch4(
		at: number,
		tok: TokenKind,
		eq: TokenKind,
		shift: TokenKind,
		shiftEq: TokenKind,
	): Token {
		if (this.peek() === "=") {
			this.pos++;
			return this.make(eq, at);
		}
		if (this.peek() === tok) {
			this.pos++;
			if (this.peek() === "=") {
				this.pos++;
				return this.make(shiftEq, at);
			}
			return this.make(shift, at);
		}
		return this.make(tok, at);
	}

	private skipSpace(): void {
		while (this.pos < this.src.length) {
			const ch = this.peek();
			if (ch === " " || ch === "\t" || ch === "\r") {
				this.pos++;
				continue;
			}
			if (ch === "\n" && !this.insertSemi) {
				this.pos++;
				continue;
			}
			return;
		}
	}

	/** Whether the comment at the cursor reaches a line end or the source end. */
	private commentEndsLine(): boolean {
		if (this.peek(1) === "/") return true;
		for (let i = this.pos + 2; i < this.src.length; i++) {
			if (this.src[i] === "\n") return true;
			if (this.src[i] === "*" && this.src[i + 1] === "/") return false;
		}
		return true;
	}

	private skipComment(): void {
		if (this.peek(1) === "/") {
			this.pos += 2;
			while (this.pos < this.src.length && this.peek() !== "\n") this.pos++;
			return;
		}
		const at = this.pos;
		this.pos += 2;
		for (;;) {
			if (this.pos >= this.src.length) this.fail("comment not terminated", at);
			if (this.peek() === "*" && this.peek(1) === "/") {
				this.pos += 2;
				return;
			}
			this.pos++;
		}
	}

	/**
	 * Scans a number, in all the forms Go's `strconv.ParseInt(s, 0, 64)` and
	 * `ParseFloat` take: `0x`/`0o`/`0b` prefixes, a bare leading `0` as octal,
	 * a fraction, and an exponent. Underscore separators are not accepted,
	 * which matches the Tengo this port is a port of.
	 */
	private scanNumber(at: number): Token {
		const src = this.src;

		if (this.peek() === "0" && /[xX]/.test(this.peek(1))) {
			this.pos += 2;
			while (/[0-9a-fA-F]/.test(this.peek())) this.pos++;
			return this.intToken(at, Number.parseInt(src.slice(at + 2, this.pos), 16));
		}
		if (this.peek() === "0" && /[oO]/.test(this.peek(1))) {
			this.pos += 2;
			while (/[0-7]/.test(this.peek())) this.pos++;
			return this.intToken(at, Number.parseInt(src.slice(at + 2, this.pos), 8));
		}
		if (this.peek() === "0" && /[bB]/.test(this.peek(1))) {
			this.pos += 2;
			while (/[01]/.test(this.peek())) this.pos++;
			return this.intToken(at, Number.parseInt(src.slice(at + 2, this.pos), 2));
		}

		while (isDigit(this.peek())) this.pos++;
		let isFloat = false;
		if (this.peek() === ".") {
			isFloat = true;
			this.pos++;
			while (isDigit(this.peek())) this.pos++;
		}
		if (/[eE]/.test(this.peek())) {
			const save = this.pos;
			this.pos++;
			if (/[+-]/.test(this.peek())) this.pos++;
			if (isDigit(this.peek())) {
				isFloat = true;
				while (isDigit(this.peek())) this.pos++;
			} else {
				this.pos = save;
			}
		}

		const text = src.slice(at, this.pos);
		if (isFloat) {
			const value = Number(text);
			if (Number.isNaN(value)) this.fail("invalid float", at);
			return { kind: "float", text, num: value, str: "", at };
		}
		// A leading 0 on an otherwise plain integer is octal, as in Go.
		const radix = text.length > 1 && text.startsWith("0") ? 8 : 10;
		if (radix === 8 && /[89]/.test(text)) this.fail("invalid integer", at);
		return this.intToken(at, Number.parseInt(text, radix));
	}

	private intToken(at: number, value: number): Token {
		if (Number.isNaN(value)) this.fail("invalid integer", at);
		return {
			kind: "int",
			text: this.src.slice(at, this.pos),
			num: value,
			str: "",
			at,
		};
	}

	private scanString(at: number): Token {
		this.pos++;
		let out = "";
		for (;;) {
			if (this.pos >= this.src.length || this.peek() === "\n") {
				this.fail("string literal not terminated", at);
			}
			const ch = this.peek();
			if (ch === '"') {
				this.pos++;
				return {
					kind: "string",
					text: this.src.slice(at, this.pos),
					num: 0,
					str: out,
					at,
				};
			}
			if (ch === "\\") {
				out += this.scanEscape('"');
				continue;
			}
			out += ch;
			this.pos++;
		}
	}

	private scanRawString(at: number): Token {
		this.pos++;
		let out = "";
		for (;;) {
			if (this.pos >= this.src.length) {
				this.fail("raw string literal not terminated", at);
			}
			const ch = this.peek();
			this.pos++;
			if (ch === "`") {
				return {
					kind: "string",
					text: this.src.slice(at, this.pos),
					num: 0,
					str: out,
					at,
				};
			}
			// Go drops carriage returns inside a raw string.
			if (ch !== "\r") out += ch;
		}
	}

	private scanChar(at: number): Token {
		this.pos++;
		let text: string;
		if (this.peek() === "\\") {
			text = this.scanEscape("'");
		} else {
			const cp = this.src.codePointAt(this.pos);
			if (cp === undefined) this.fail("rune literal not terminated", at);
			text = String.fromCodePoint(cp);
			this.pos += text.length;
		}
		if (this.peek() !== "'") this.fail("rune literal not terminated", at);
		this.pos++;
		return {
			kind: "char",
			text: this.src.slice(at, this.pos),
			num: text.codePointAt(0) ?? 0,
			str: text,
			at,
		};
	}

	/** Reads one backslash escape, leaving the cursor after it. */
	private scanEscape(quote: string): string {
		const at = this.pos;
		this.pos++;
		const ch = this.peek();
		this.pos++;
		switch (ch) {
			case "a":
				return "\x07";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "v":
				return "\v";
			case "\\":
				return "\\";
			case quote:
				return quote;
			case "x":
				return this.hexEscape(2, at);
			case "u":
				return this.hexEscape(4, at);
			case "U":
				return this.hexEscape(8, at);
		}
		if (/[0-7]/.test(ch)) {
			let digits = ch;
			while (digits.length < 3 && /[0-7]/.test(this.peek())) {
				digits += this.peek();
				this.pos++;
			}
			return String.fromCharCode(Number.parseInt(digits, 8));
		}
		this.fail("unknown escape sequence", at);
	}

	private hexEscape(width: number, at: number): string {
		let digits = "";
		while (digits.length < width && /[0-9a-fA-F]/.test(this.peek())) {
			digits += this.peek();
			this.pos++;
		}
		if (digits.length !== width) this.fail("invalid escape sequence", at);
		const code = Number.parseInt(digits, 16);
		// \x is a byte, which in a UTF-8 Go literal is a code unit; \u and \U
		// name code points.
		return width === 2 ? String.fromCharCode(code) : String.fromCodePoint(code);
	}
}

function isLetter(ch: string): boolean {
	return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function isDigit(ch: string): boolean {
	return ch >= "0" && ch <= "9";
}

function isAlnum(ch: string): boolean {
	return isLetter(ch) || isDigit(ch);
}
