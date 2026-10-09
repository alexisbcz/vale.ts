/**
 * The parser, following Tengo's.
 *
 * Three rules it enforces are Tengo compile-time errors rather than parse
 * errors, and are checked here because this port has no separate compile pass
 * and the parser is where the offending shape is still in hand: tuple
 * assignment, `:=` against a selector or index, and `export` inside a
 * function. Rejecting them here gives the same answer at the same moment a
 * style author would get it from Tengo -- before the program ever runs.
 *
 * Note that `{` in statement position starts a map literal, not a block. Tengo
 * has no bare block statement; a block only ever belongs to an `if`, a `for`
 * or a function literal.
 */

import type { BlockStmt, Expr, FuncLit, Program, Stmt, UnaryExpr } from "./ast.ts";
import type { Token, TokenKind } from "./lexer.ts";
import { tokenize } from "./lexer.ts";
import { TengoError } from "./values.ts";

/** Binding power per binary operator; unary binds tighter than all of them. */
const PRECEDENCE: Partial<Record<TokenKind, number>> = {
	"||": 1,
	"&&": 2,
	"==": 3,
	"!=": 3,
	"<": 3,
	"<=": 3,
	">": 3,
	">=": 3,
	"+": 4,
	"-": 4,
	"|": 4,
	"^": 4,
	"*": 5,
	"/": 5,
	"%": 5,
	"<<": 5,
	">>": 5,
	"&": 5,
	"&^": 5,
};

const COMPOUND_ASSIGN = new Set<TokenKind>([
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"<<=",
	">>=",
	"&^=",
]);

/** Tokens that can open a simple statement. */
const STARTS_SIMPLE = new Set<TokenKind>([
	"func",
	"error",
	"immutable",
	"ident",
	"int",
	"float",
	"char",
	"string",
	"true",
	"false",
	"undefined",
	"import",
	"(",
	"{",
	"[",
	"+",
	"-",
	"!",
	"^",
]);

/** Parses `source`, throwing `TengoError` on a syntax error. */
export function parse(source: string): Program {
	return new Parser(source).parseProgram();
}

class Parser {
	private readonly src: string;
	private readonly tokens: Token[];
	private i = 0;
	/** How many function literals enclose the cursor, for `export`. */
	private funcDepth = 0;

	constructor(source: string) {
		this.src = source;
		this.tokens = tokenize(source);
	}

	parseProgram(): Program {
		const body = this.parseStmtList();
		this.expect("eof");
		return { body };
	}

	private get tok(): Token {
		return this.tokens[this.i]!;
	}

	/**
	 * The kind of the token at the cursor.
	 *
	 * A method rather than a getter, so that the compiler does not carry a
	 * narrowing of it across the `next` call that moved the cursor on.
	 */
	private current(): TokenKind {
		return this.tok.kind;
	}

	private next(): void {
		if (this.tok.kind !== "eof") this.i++;
	}

	private fail(message: string, at = this.tok.at): never {
		let line = 1;
		for (let i = 0; i < at && i < this.src.length; i++) {
			if (this.src[i] === "\n") line++;
		}
		throw new TengoError(`${line}: ${message}`);
	}

	private expect(kind: TokenKind): Token {
		const tok = this.tok;
		if (tok.kind !== kind) {
			this.fail(`expected '${kind}', found '${describe(tok)}'`);
		}
		this.next();
		return tok;
	}

	/** Consumes the statement terminator, which `)` and `}` stand in for. */
	private expectSemi(): void {
		if (this.current() === ")" || this.current() === "}") return;
		if (this.current() === ";") {
			this.next();
			return;
		}
		this.fail(`expected ';', found '${describe(this.tok)}'`);
	}

	// --- statements -------------------------------------------------------

	private parseStmtList(): Stmt[] {
		const out: Stmt[] = [];
		while (this.current() !== "}" && this.current() !== "eof") {
			out.push(this.parseStmt());
		}
		return out;
	}

	private parseStmt(): Stmt {
		const at = this.tok.at;
		const opening = this.current();

		if (STARTS_SIMPLE.has(opening)) {
			const stmt = this.parseSimpleStmt(false);
			this.expectSemi();
			return stmt;
		}

		switch (opening) {
			case "return": {
				this.next();
				let value: Expr | null = null;
				if (this.current() !== ";" && this.current() !== "}")
					value = this.parseExpr();
				this.expectSemi();
				return { kind: "return", at, value };
			}
			case "export": {
				if (this.funcDepth > 0) {
					this.fail("export not allowed inside function");
				}
				this.next();
				const value = this.parseExpr();
				this.expectSemi();
				return { kind: "export", at, value };
			}
			case "if":
				return this.parseIfStmt();
			case "for":
				return this.parseForStmt();
			case "break":
			case "continue": {
				const op = opening;
				this.next();
				// Tengo's parser accepts a label here and its compiler rejects
				// it; a label is simply not part of the language.
				if (this.current() === "ident") this.fail("labels are not supported");
				this.expectSemi();
				return { kind: "branch", at, op };
			}
			case ";":
				this.next();
				return { kind: "empty", at };
			default:
				this.fail(`expected statement, found '${describe(this.tok)}'`);
		}
	}

	/**
	 * An expression, an assignment, a `++`/`--`, or -- when `forIn` -- the
	 * `k, v in x` header of a for-in loop.
	 */
	private parseSimpleStmt(forIn: boolean): Stmt {
		const at = this.tok.at;
		const first = this.parseExpr();

		if (forIn && this.current() === "in") {
			this.next();
			const iterable = this.parseExpr();
			const value = identName(first) ?? this.fail("expected identifier", at);
			return {
				kind: "forIn",
				at,
				key: "_",
				value,
				iterable,
				body: { kind: "block", at, body: [] },
			};
		}

		if (this.current() === ",") {
			this.next();
			const second = this.parseExpr();
			if (forIn && this.current() === "in") {
				this.next();
				const iterable = this.parseExpr();
				const key = identName(first) ?? this.fail("expected identifier", at);
				const value =
					identName(second) ?? this.fail("expected identifier", second.at);
				return {
					kind: "forIn",
					at,
					key,
					value,
					iterable,
					body: { kind: "block", at, body: [] },
				};
			}
			this.fail("tuple assignment not allowed", at);
		}

		if (
			this.current() === "=" ||
			this.current() === ":=" ||
			COMPOUND_ASSIGN.has(this.current())
		) {
			const op = this.current();
			this.next();
			const value = this.parseExpr();
			if (op === ":=" && first.kind !== "ident") {
				this.fail("operator ':=' not allowed with selector", at);
			}
			if (
				first.kind !== "ident" &&
				first.kind !== "index" &&
				first.kind !== "selector"
			) {
				this.fail("cannot assign to this expression", at);
			}
			return { kind: "assign", at, op, target: first, value };
		}

		const after = this.current();
		if (after === "++" || after === "--") {
			this.next();
			return { kind: "incDec", at, op: after, target: first };
		}

		return { kind: "exprStmt", at, expr: first };
	}

	private parseIfStmt(): Stmt {
		const at = this.expect("if").at;
		const { init, cond } = this.parseIfHeader();
		const then = this.parseBlockStmt();

		let otherwise: Stmt | null = null;
		if (this.current() === "else") {
			this.next();
			if (this.current() === "if") {
				otherwise = this.parseIfStmt();
			} else if (this.current() === "{") {
				otherwise = this.parseBlockStmt();
				this.expectSemi();
			} else {
				this.fail(`expected if or {, found '${describe(this.tok)}'`);
			}
		} else {
			this.expectSemi();
		}

		return { kind: "if", at, init, cond, then, otherwise };
	}

	private parseIfHeader(): { init: Stmt | null; cond: Expr } {
		if (this.current() === "{") this.fail("missing condition in if statement");
		if (this.current() === ";") this.fail("missing init in if statement");

		let init: Stmt | null = this.parseSimpleStmt(false);
		let condStmt: Stmt;
		if (this.current() === "{") {
			condStmt = init;
			init = null;
		} else if (this.current() === ";") {
			this.next();
			condStmt = this.parseSimpleStmt(false);
		} else {
			this.fail("missing condition in if statement");
		}

		return { init, cond: this.asExpr(condStmt, "boolean expression") };
	}

	private parseForStmt(): Stmt {
		const at = this.expect("for").at;

		// for {}
		if (this.current() === "{") {
			const body = this.parseBlockStmt();
			this.expectSemi();
			return { kind: "for", at, init: null, cond: null, post: null, body };
		}

		let first: Stmt | null = null;
		if (this.current() !== ";") first = this.parseSimpleStmt(true);

		if (first !== null && first.kind === "forIn") {
			first.body = this.parseBlockStmt();
			this.expectSemi();
			return first;
		}

		let init: Stmt | null = first;
		let condStmt: Stmt | null = null;
		let post: Stmt | null = null;

		if (this.current() === ";") {
			// for init; cond; post {}
			this.next();
			if (this.current() !== ";") condStmt = this.parseSimpleStmt(false);
			this.expect(";");
			if (this.current() !== "{") post = this.parseSimpleStmt(false);
		} else {
			// for cond {}
			condStmt = init;
			init = null;
		}

		const body = this.parseBlockStmt();
		this.expectSemi();
		const cond =
			condStmt === null ? null : this.asExpr(condStmt, "condition expression");
		return { kind: "for", at, init, cond, post, body };
	}

	private parseBlockStmt(): BlockStmt {
		const at = this.expect("{").at;
		const body = this.parseStmtList();
		this.expect("}");
		return { kind: "block", at, body };
	}

	private asExpr(stmt: Stmt, want: string): Expr {
		if (stmt.kind === "exprStmt") return stmt.expr;
		this.fail(`expected ${want}, found statement`, stmt.at);
	}

	// --- expressions ------------------------------------------------------

	private parseExpr(): Expr {
		const expr = this.parseBinaryExpr(1);
		if (this.current() === "?") {
			const at = this.tok.at;
			this.next();
			const then = this.parseExpr();
			this.expect(":");
			const otherwise = this.parseExpr();
			return { kind: "cond", at, test: expr, then, otherwise };
		}
		return expr;
	}

	private parseBinaryExpr(minPrec: number): Expr {
		let left = this.parseUnaryExpr();
		for (;;) {
			const op = this.current();
			const prec = PRECEDENCE[op] ?? 0;
			if (prec < minPrec) return left;
			const at = this.tok.at;
			this.next();
			const right = this.parseBinaryExpr(prec + 1);
			left = { kind: "binary", at, op, left, right };
		}
	}

	private parseUnaryExpr(): Expr {
		const op = this.current();
		if (op === "+" || op === "-" || op === "!" || op === "^") {
			const at = this.tok.at;
			this.next();
			const operand = this.parseUnaryExpr();
			return { kind: "unary", at, op, operand } satisfies UnaryExpr;
		}
		return this.parsePrimaryExpr();
	}

	private parsePrimaryExpr(): Expr {
		let x = this.parseOperand();
		for (;;) {
			switch (this.current()) {
				case ".": {
					const at = this.tok.at;
					this.next();
					if (this.current() !== "ident") {
						this.fail(`expected selector, found '${describe(this.tok)}'`);
					}
					const name = this.tok.text;
					this.next();
					x = { kind: "selector", at, target: x, name };
					break;
				}
				case "[":
					x = this.parseIndexOrSlice(x);
					break;
				case "(":
					x = this.parseCall(x);
					break;
				default:
					return x;
			}
		}
	}

	private parseIndexOrSlice(target: Expr): Expr {
		const at = this.expect("[").at;

		let low: Expr | null = null;
		if (this.current() !== ":") low = this.parseExpr();

		if (this.current() === ":") {
			this.next();
			let high: Expr | null = null;
			if (this.current() !== "]" && this.current() !== "eof")
				high = this.parseExpr();
			this.expect("]");
			return { kind: "slice", at, target, low, high };
		}

		this.expect("]");
		if (low === null) this.fail("missing index", at);
		return { kind: "index", at, target, index: low };
	}

	private parseCall(callee: Expr): Expr {
		const at = this.expect("(").at;
		const args: Expr[] = [];
		let spread = false;

		while (this.current() !== ")" && this.current() !== "eof" && !spread) {
			args.push(this.parseExpr());
			if (this.current() === "...") {
				spread = true;
				this.next();
			}
			if (!this.expectComma(")", "call argument")) break;
		}

		this.expect(")");
		return { kind: "call", at, callee, args, spread };
	}

	/**
	 * Consumes a separator, reporting whether another element follows.
	 *
	 * A newline between elements is swallowed, which is how a literal written
	 * across several lines holds together.
	 */
	private expectComma(closing: TokenKind, want: string): boolean {
		if (this.current() === ",") {
			this.next();
			while (this.current() === ";" && this.tok.text === "\n") this.next();
			if (this.current() === closing) return false;
			return true;
		}
		if (this.current() === ";" && this.tok.text === "\n") {
			this.next();
			if (this.current() === closing) return false;
			this.fail(`expected ',' or '${closing}' after ${want}`);
		}
		return false;
	}

	private parseOperand(): Expr {
		const tok = this.tok;
		const at = tok.at;

		switch (tok.kind) {
			case "ident":
				this.next();
				return { kind: "ident", at, name: tok.text };
			case "int":
				this.next();
				return { kind: "int", at, value: tok.num };
			case "float":
				this.next();
				return { kind: "float", at, value: tok.num };
			case "char":
				this.next();
				return { kind: "char", at, value: tok.num };
			case "string":
				this.next();
				return { kind: "string", at, value: tok.str };
			case "true":
				this.next();
				return { kind: "bool", at, value: true };
			case "false":
				this.next();
				return { kind: "bool", at, value: false };
			case "undefined":
				this.next();
				return { kind: "undefinedLit", at };
			case "import": {
				this.next();
				this.expect("(");
				if (this.current() !== "string") this.fail("expected module name");
				const module = this.tok.str;
				this.next();
				this.expect(")");
				return { kind: "import", at, module };
			}
			case "(": {
				this.next();
				const inner = this.parseExpr();
				this.expect(")");
				return inner;
			}
			case "[":
				return this.parseArrayLit();
			case "{":
				return this.parseMapLit();
			case "func":
				return this.parseFuncLit();
			case "error": {
				this.next();
				this.expect("(");
				const value = this.parseExpr();
				this.expect(")");
				return { kind: "errorExpr", at, value };
			}
			case "immutable": {
				this.next();
				this.expect("(");
				const value = this.parseExpr();
				this.expect(")");
				return { kind: "immutableExpr", at, value };
			}
			default:
				this.fail(`expected operand, found '${describe(tok)}'`);
		}
	}

	private parseArrayLit(): Expr {
		const at = this.expect("[").at;
		const elements: Expr[] = [];
		while (this.current() !== "]" && this.current() !== "eof") {
			elements.push(this.parseExpr());
			if (!this.expectComma("]", "array element")) break;
		}
		this.expect("]");
		return { kind: "arrayLit", at, elements };
	}

	private parseMapLit(): Expr {
		const at = this.expect("{").at;
		const entries: Array<{ key: string; value: Expr }> = [];
		while (this.current() !== "}" && this.current() !== "eof") {
			let key: string;
			if (this.current() === "ident") {
				key = this.tok.text;
			} else if (this.current() === "string") {
				key = this.tok.str;
			} else {
				this.fail(`expected map key, found '${describe(this.tok)}'`);
			}
			this.next();
			this.expect(":");
			entries.push({ key, value: this.parseExpr() });
			if (!this.expectComma("}", "map element")) break;
		}
		this.expect("}");
		return { kind: "mapLit", at, entries };
	}

	private parseFuncLit(): FuncLit {
		const at = this.expect("func").at;
		const { params, variadic } = this.parseParamList();
		this.funcDepth++;
		const body = this.parseBlockStmt();
		this.funcDepth--;
		return { kind: "funcLit", at, params, variadic, body };
	}

	private parseParamList(): { params: string[]; variadic: boolean } {
		this.expect("(");
		const params: string[] = [];
		let variadic = false;

		if (this.current() !== ")") {
			if (this.current() === "...") {
				variadic = true;
				this.next();
			}
			params.push(this.expect("ident").text);
			while (!variadic && this.current() === ",") {
				this.next();
				if (this.current() === "...") {
					variadic = true;
					this.next();
				}
				params.push(this.expect("ident").text);
			}
		}

		this.expect(")");
		return { params, variadic };
	}
}

function identName(expr: Expr): string | null {
	return expr.kind === "ident" ? expr.name : null;
}

function describe(tok: Token): string {
	if (tok.kind === "eof") return "EOF";
	if (tok.kind === ";" && tok.text === "\n") return "newline";
	return tok.text;
}
