/**
 * The subset of Go's `text/template` that Vale's own templates use.
 *
 * `--output=<path>` renders a user-supplied template, and the four Vale ships
 * -- `cli.tmpl`, `line.tmpl`, `gitlab.tmpl` and `collate.tmpl` -- are the
 * specification for what has to work. Pulling in a full template engine to
 * reproduce them would be more code than writing the parts they reach for.
 *
 * # The subset
 *
 * Supported:
 *
 * - `{{ ... }}` actions, with `{{-` and `-}}` trimming the surrounding
 *   whitespace, and `{{/* ... *\/}}` comments.
 * - `if` / `else if` / `else` / `end`, with Go's truth: `false`, `0`, `""`,
 *   `nil`, and an empty list or map are false.
 * - `range` over a list or a map, with `{{range $i, $v := ...}}` and an
 *   `else` branch for an empty one. A map is ranged in sorted key order, as
 *   Go does.
 * - `with` / `else` / `end`.
 * - `$name := ...` declaration and `$name = ...` assignment. Assignment finds
 *   the variable in an enclosing scope, which is what lets a counter declared
 *   above a `range` be incremented inside it.
 * - `.`, `.Field`, `.Field.Nested`, `$var.Field`, and `$` for the root.
 * - String (`"..."` with Go's escapes, and raw backquoted), number, `true`,
 *   `false` and `nil` literals.
 * - Pipelines (`a | b | c`), parenthesized sub-expressions, and function calls
 *   with positional arguments.
 * - The builtins `and`, `eq`, `ge`, `gt`, `index`, `le`, `len`, `lt`, `ne`,
 *   `not`, `or`, `print`, `printf` and `println`, plus the named functions in
 *   `funcs.ts`.
 *
 * Not supported, because no Vale template uses them: `template`, `define`,
 *   `block`, method calls, `html`/`js` escaping, and variadic `range` over a
 *   channel.
 */

/** A function a template may call. */
export type TemplateFunc = (...args: unknown[]) => unknown;

/** Where a template's text goes, so a printing function can interleave. */
export type Emit = (text: string) => void;

// --- lexing ---------------------------------------------------------------

type TokenKind =
	| "ident"
	| "field"
	| "variable"
	| "string"
	| "number"
	| "lparen"
	| "rparen"
	| "pipe"
	| "declare"
	| "assign"
	| "comma"
	| "dot"
	| "eof";

interface Token {
	kind: TokenKind;
	text: string;
}

const KEYWORDS = new Set(["if", "else", "end", "range", "with"]);

/** Splits one action's text into tokens. */
function lexAction(src: string, where: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	const fail = (msg: string): never => {
		throw new Error(`${where}: ${msg}`);
	};

	while (i < src.length) {
		const ch = src[i] as string;

		if (/\s/.test(ch)) {
			i++;
			continue;
		}

		if (ch === "(") {
			tokens.push({ kind: "lparen", text: ch });
			i++;
			continue;
		}
		if (ch === ")") {
			tokens.push({ kind: "rparen", text: ch });
			i++;
			continue;
		}
		if (ch === "|") {
			tokens.push({ kind: "pipe", text: ch });
			i++;
			continue;
		}
		if (ch === ",") {
			tokens.push({ kind: "comma", text: ch });
			i++;
			continue;
		}
		if (ch === ":" && src[i + 1] === "=") {
			tokens.push({ kind: "declare", text: ":=" });
			i += 2;
			continue;
		}
		if (ch === "=") {
			tokens.push({ kind: "assign", text: "=" });
			i++;
			continue;
		}

		if (ch === '"') {
			const [text, next] = lexQuoted(src, i, where);
			tokens.push({ kind: "string", text });
			i = next;
			continue;
		}
		if (ch === "`") {
			const end = src.indexOf("`", i + 1);
			if (end < 0) fail("unterminated raw string");
			tokens.push({ kind: "string", text: src.slice(i + 1, end) });
			i = end + 1;
			continue;
		}

		if (ch === "$") {
			let j = i + 1;
			while (j < src.length && /[\w]/.test(src[j] as string)) j++;
			tokens.push({ kind: "variable", text: src.slice(i, j) });
			i = j;
			continue;
		}

		if (ch === ".") {
			let j = i;
			// `.`, or a chain of `.Name` segments.
			while (j < src.length && src[j] === ".") {
				j++;
				const start = j;
				while (j < src.length && /[\w]/.test(src[j] as string)) j++;
				if (j === start) break;
			}
			const text = src.slice(i, j);
			tokens.push({ kind: text === "." ? "dot" : "field", text });
			i = j;
			continue;
		}

		if (/[-+0-9]/.test(ch) && (ch !== "-" || /[0-9.]/.test(src[i + 1] ?? ""))) {
			let j = i + 1;
			while (j < src.length && /[0-9.eExXa-fA-F]/.test(src[j] as string)) j++;
			tokens.push({ kind: "number", text: src.slice(i, j) });
			i = j;
			continue;
		}

		if (/[A-Za-z_]/.test(ch)) {
			let j = i;
			while (j < src.length && /[\w]/.test(src[j] as string)) j++;
			tokens.push({ kind: "ident", text: src.slice(i, j) });
			i = j;
			continue;
		}

		fail(`unexpected character ${JSON.stringify(ch)}`);
	}

	tokens.push({ kind: "eof", text: "" });
	return tokens;
}

/** Reads a quoted string with Go's escapes, returning it and the next index. */
function lexQuoted(src: string, start: number, where: string): [string, number] {
	let out = "";
	let i = start + 1;

	while (i < src.length) {
		const ch = src[i] as string;
		if (ch === '"') return [out, i + 1];
		if (ch !== "\\") {
			out += ch;
			i++;
			continue;
		}

		const esc = src[i + 1] as string;
		i += 2;
		switch (esc) {
			case "n":
				out += "\n";
				break;
			case "t":
				out += "\t";
				break;
			case "r":
				out += "\r";
				break;
			case "\\":
				out += "\\";
				break;
			case '"':
				out += '"';
				break;
			case "a":
				out += "\u0007";
				break;
			case "b":
				out += "\b";
				break;
			case "f":
				out += "\f";
				break;
			case "v":
				out += "\v";
				break;
			case "x": {
				out += String.fromCodePoint(parseInt(src.slice(i, i + 2), 16));
				i += 2;
				break;
			}
			case "u": {
				out += String.fromCodePoint(parseInt(src.slice(i, i + 4), 16));
				i += 4;
				break;
			}
			default:
				out += esc;
		}
	}

	throw new Error(`${where}: unterminated string`);
}

// --- the tree -------------------------------------------------------------

interface TextNode {
	kind: "text";
	text: string;
}

interface ActionNode {
	kind: "action";
	pipe: Pipeline;
}

interface BranchNode {
	kind: "if" | "range" | "with";
	pipe: Pipeline;
	list: Node[];
	elseList: Node[];
}

type Node = TextNode | ActionNode | BranchNode;

/** A pipeline, with the variables it declares or assigns to. */
interface Pipeline {
	/** `$x` in `$x := ...`, or `$i, $v` in a `range`. */
	vars: string[];
	/** Whether the variables are being declared (`:=`) or assigned (`=`). */
	declare: boolean;
	commands: Command[];
}

/** One stage of a pipeline: a function or value, and its arguments. */
interface Command {
	operands: Operand[];
}

type Operand =
	| { kind: "dot" }
	| { kind: "root" }
	| { kind: "field"; path: string[] }
	| { kind: "variable"; name: string; path: string[] }
	| { kind: "string"; value: string }
	| { kind: "number"; value: number }
	| { kind: "bool"; value: boolean }
	| { kind: "nil" }
	| { kind: "ident"; name: string }
	| { kind: "pipe"; pipe: Pipeline };

// --- parsing --------------------------------------------------------------

/** One `{{...}}` or the text between two of them. */
interface Chunk {
	text: string;
	action: boolean;
}

/** Splits the source into text and actions, applying `{{-` and `-}}`. */
function split(src: string, where: string): Chunk[] {
	const chunks: Chunk[] = [];
	let i = 0;
	let pendingTrimLeft = false;

	const pushText = (text: string, trimRight: boolean) => {
		let out = text;
		if (pendingTrimLeft) out = out.replace(/^\s+/, "");
		if (trimRight) out = out.replace(/\s+$/, "");
		if (out !== "") chunks.push({ text: out, action: false });
	};

	while (i < src.length) {
		const open = src.indexOf("{{", i);
		if (open < 0) {
			pushText(src.slice(i), false);
			break;
		}

		let body: string;
		let close: number;

		// A comment may hold `}}`, so it is matched by its own delimiter.
		const afterOpen = src.slice(open + 2).replace(/^-?\s*/, "");
		if (afterOpen.startsWith("/*")) {
			const end = src.indexOf("*/", open + 2);
			if (end < 0) throw new Error(`${where}: unclosed comment`);
			close = src.indexOf("}}", end);
			if (close < 0) throw new Error(`${where}: unclosed action`);
			body = src.slice(open + 2, close);
		} else {
			close = src.indexOf("}}", open + 2);
			if (close < 0) throw new Error(`${where}: unclosed action`);
			body = src.slice(open + 2, close);
		}

		const trimRight = body.startsWith("-") && /^-\s/.test(body);
		const trimLeftNext = /\s-$/.test(body);

		let inner = body;
		if (trimRight) inner = inner.slice(1);
		if (trimLeftNext) inner = inner.slice(0, -1);
		inner = inner.trim();

		pushText(src.slice(i, open), trimRight);
		pendingTrimLeft = trimLeftNext;

		// Comments contribute nothing but their trimming.
		if (!/^\/\*[\s\S]*\*\/$/.test(inner)) {
			chunks.push({ text: inner, action: true });
		}

		i = close + 2;
	}

	return chunks;
}

/** Parses a template into its nodes. */
export function parseTemplate(src: string, name: string): Node[] {
	const chunks = split(src, name);
	let at = 0;

	const parseList = (stop: ReadonlySet<string>): [Node[], string] => {
		const list: Node[] = [];

		while (at < chunks.length) {
			const chunk = chunks[at] as Chunk;
			if (!chunk.action) {
				list.push({ kind: "text", text: chunk.text });
				at++;
				continue;
			}

			const first = chunk.text.split(/\s/)[0] ?? "";
			if (KEYWORDS.has(first) && stop.has(first)) {
				at++;
				return [list, chunk.text];
			}

			at++;
			switch (first) {
				case "if":
					list.push(parseIfChain(chunk.text.slice(2)));
					break;
				case "range":
				case "with":
					list.push(parseLoop(first, chunk.text.slice(first.length)));
					break;
				case "end":
				case "else":
					throw new Error(`${name}: unexpected ${first}`);
				default:
					list.push({
						kind: "action",
						pipe: parsePipeline(chunk.text, name),
					});
			}
		}

		return [list, ""];
	};

	/**
	 * An `if`, with `else if` read as a nested `if` in the else branch -- which
	 * is how Go's parser reads it, and why the whole chain closes on one `end`.
	 */
	const parseIfChain = (pipeText: string): BranchNode => {
		const node: BranchNode = {
			kind: "if",
			pipe: parsePipeline(pipeText, name),
			list: [],
			elseList: [],
		};

		const [body, closed] = parseList(ELSE_OR_END);
		node.list = body;

		if (closed.startsWith("else")) {
			const rest = closed.slice(4).trim();
			if (rest === "") {
				const [tail] = parseList(END_ONLY);
				node.elseList = tail;
			} else {
				node.elseList = [parseIfChain(rest.replace(/^if\b/, ""))];
			}
		}

		return node;
	};

	/** A `range` or a `with`, each of which may have one `else`. */
	const parseLoop = (kind: "range" | "with", pipeText: string): BranchNode => {
		const node: BranchNode = {
			kind,
			pipe: parsePipeline(pipeText, name),
			list: [],
			elseList: [],
		};

		const [body, closed] = parseList(ELSE_OR_END);
		node.list = body;

		if (closed.startsWith("else")) {
			const [tail] = parseList(END_ONLY);
			node.elseList = tail;
		}

		return node;
	};

	const [nodes, closed] = parseList(NOTHING);
	if (closed !== "") throw new Error(`${name}: unexpected ${closed}`);
	return nodes;
}

const NOTHING: ReadonlySet<string> = new Set();
const END_ONLY: ReadonlySet<string> = new Set(["end"]);
const ELSE_OR_END: ReadonlySet<string> = new Set(["else", "end"]);

/** Parses one pipeline, including any leading variable declaration. */
function parsePipeline(src: string, where: string): Pipeline {
	const tokens = lexAction(src, where);
	let at = 0;

	const peek = (): Token => tokens[at] as Token;
	const next = (): Token => tokens[at++] as Token;

	const pipe: Pipeline = { vars: [], declare: false, commands: [] };

	// `$x := `, `$x = `, or `$i, $v := `.
	const save = at;
	const vars: string[] = [];
	while (peek().kind === "variable") {
		vars.push(next().text);
		if (peek().kind === "comma") {
			next();
			continue;
		}
		break;
	}
	if (vars.length > 0 && (peek().kind === "declare" || peek().kind === "assign")) {
		pipe.declare = next().kind === "declare";
		pipe.vars = vars;
	} else {
		at = save;
	}

	const parseOperand = (): Operand => {
		const token = next();
		switch (token.kind) {
			case "dot":
				return { kind: "dot" };
			case "field":
				return { kind: "field", path: token.text.slice(1).split(".") };
			case "variable": {
				const [name, ...path] = token.text.split(".");
				if (name === "$" && path.length === 0) return { kind: "root" };
				return { kind: "variable", name: name as string, path };
			}
			case "string":
				return { kind: "string", value: token.text };
			case "number":
				return { kind: "number", value: Number(token.text) };
			case "ident":
				if (token.text === "true") return { kind: "bool", value: true };
				if (token.text === "false") return { kind: "bool", value: false };
				if (token.text === "nil") return { kind: "nil" };
				return { kind: "ident", name: token.text };
			case "lparen": {
				const inner = parsePipelineTokens();
				if (next().kind !== "rparen") {
					throw new Error(`${where}: missing )`);
				}
				return { kind: "pipe", pipe: inner };
			}
			default:
				throw new Error(`${where}: unexpected ${token.text || "end of action"}`);
		}
	};

	const parseCommand = (): Command => {
		const operands: Operand[] = [parseOperand()];
		while (
			peek().kind !== "eof" &&
			peek().kind !== "pipe" &&
			peek().kind !== "rparen"
		) {
			operands.push(parseOperand());
		}
		return { operands };
	};

	function parsePipelineTokens(): Pipeline {
		const nested: Pipeline = { vars: [], declare: false, commands: [] };
		nested.commands.push(parseCommand());
		while (peek().kind === "pipe") {
			next();
			nested.commands.push(parseCommand());
		}
		return nested;
	}

	if (peek().kind !== "eof") {
		const body = parsePipelineTokens();
		pipe.commands = body.commands;
	}

	return pipe;
}

// --- evaluation -----------------------------------------------------------

/** A template's variables, with the chain that lets `=` reach an outer one. */
class Scope {
	private readonly own = new Map<string, unknown>();

	constructor(private readonly parent: Scope | null) {}

	declare(name: string, value: unknown): void {
		this.own.set(name, value);
	}

	/** Finds and updates an existing variable, or declares it here. */
	assign(name: string, value: unknown): void {
		let scope: Scope | null = this;
		while (scope !== null) {
			if (scope.own.has(name)) {
				scope.own.set(name, value);
				return;
			}
			scope = scope.parent;
		}
		this.own.set(name, value);
	}

	get(name: string): unknown {
		let scope: Scope | null = this;
		while (scope !== null) {
			if (scope.own.has(name)) return scope.own.get(name);
			scope = scope.parent;
		}
		return undefined;
	}

	child(): Scope {
		return new Scope(this);
	}
}

/** Whether a value is true the way Go's `if` is. */
export function truthy(value: unknown): boolean {
	if (value === undefined || value === null || value === false) return false;
	if (value === true) return true;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") return value !== "";
	if (Array.isArray(value)) return value.length > 0;
	if (value instanceof Map) return value.size > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}

/** A value as a template prints it, which is Go's `%v`. */
export function stringify(value: unknown): string {
	if (value === undefined || value === null) return "<no value>";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) return `[${value.map(stringify).join(" ")}]`;
	if (value instanceof Map) {
		const keys = [...value.keys()].map(String).sort();
		return `map[${keys.map((k) => `${k}:${stringify(value.get(k))}`).join(" ")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `map[${keys.map((k) => `${k}:${stringify(record[k])}`).join(" ")}]`;
	}
	return String(value);
}

/** A rendered template, ready to run against any data. */
export class Template {
	private readonly nodes: Node[];

	constructor(
		src: string,
		readonly name: string,
		private readonly funcs: Record<string, TemplateFunc>,
	) {
		this.nodes = parseTemplate(src, name);
	}

	/** Runs the template, writing its output through `emit`. */
	execute(data: unknown, emit: Emit): void {
		const root = new Scope(null);
		root.declare("$", data);
		this.walk(this.nodes, data, root, emit);
	}

	private walk(nodes: Node[], dot: unknown, scope: Scope, emit: Emit): void {
		for (const node of nodes) {
			switch (node.kind) {
				case "text":
					emit(node.text);
					break;
				case "action": {
					const value = this.pipeline(node.pipe, dot, scope);
					if (node.pipe.vars.length === 0) emit(stringify(value));
					break;
				}
				case "if": {
					const value = this.pipeline(node.pipe, dot, scope);
					const inner = scope.child();
					if (truthy(value)) this.walk(node.list, dot, inner, emit);
					else this.walk(node.elseList, dot, inner, emit);
					break;
				}
				case "with": {
					const value = this.pipeline(node.pipe, dot, scope);
					const inner = scope.child();
					if (truthy(value)) this.walk(node.list, value, inner, emit);
					else this.walk(node.elseList, dot, inner, emit);
					break;
				}
				case "range":
					this.range(node, dot, scope, emit);
					break;
			}
		}
	}

	private range(
		node: BranchNode,
		dot: unknown,
		scope: Scope,
		emit: Emit,
	): void {
		const value = this.pipeline({ ...node.pipe, vars: [] }, dot, scope);

		const entries: Array<[unknown, unknown]> = [];
		if (Array.isArray(value)) {
			value.forEach((v, i) => entries.push([i, v]));
		} else if (value instanceof Map) {
			for (const k of [...value.keys()].sort()) entries.push([k, value.get(k)]);
		} else if (typeof value === "number") {
			for (let i = 0; i < value; i++) entries.push([i, i]);
		} else if (value !== null && typeof value === "object") {
			const record = value as Record<string, unknown>;
			for (const k of Object.keys(record).sort()) entries.push([k, record[k]]);
		}

		if (entries.length === 0) {
			this.walk(node.elseList, dot, scope.child(), emit);
			return;
		}

		for (const [key, item] of entries) {
			const inner = scope.child();
			const vars = node.pipe.vars;
			if (vars.length === 1) {
				inner.declare(vars[0] as string, item);
			} else if (vars.length >= 2) {
				inner.declare(vars[0] as string, key);
				inner.declare(vars[1] as string, item);
			}
			this.walk(node.list, item, inner, emit);
		}
	}

	/** Runs a pipeline and performs any declaration or assignment it carries. */
	private pipeline(pipe: Pipeline, dot: unknown, scope: Scope): unknown {
		let value: unknown;
		let first = true;

		for (const command of pipe.commands) {
			value = this.command(command, dot, scope, first ? undefined : value, !first);
			first = false;
		}

		for (const name of pipe.vars) {
			if (pipe.declare) scope.declare(name, value);
			else scope.assign(name, value);
		}

		return value;
	}

	private command(
		command: Command,
		dot: unknown,
		scope: Scope,
		piped: unknown,
		hasPiped: boolean,
	): unknown {
		const [head, ...rest] = command.operands;
		if (head === undefined) return undefined;

		const args = rest.map((o) => this.operand(o, dot, scope));
		if (hasPiped) args.push(piped);

		if (head.kind === "ident") {
			const fn = this.funcs[head.name] ?? BUILTINS[head.name];
			if (fn === undefined) {
				throw new Error(`${this.name}: function "${head.name}" not defined`);
			}
			return fn(...args);
		}

		const value = this.operand(head, dot, scope);
		if (args.length === 0) return value;

		// Go rejects arguments to a non-function; a pipeline into a value is
		// the one place it reads as a mistake worth naming.
		throw new Error(`${this.name}: can't give argument to non-function`);
	}

	private operand(operand: Operand, dot: unknown, scope: Scope): unknown {
		switch (operand.kind) {
			case "dot":
				return dot;
			case "root":
				return scope.get("$");
			case "field":
				return field(dot, operand.path);
			case "variable":
				return field(scope.get(operand.name), operand.path);
			case "string":
				return operand.value;
			case "number":
				return operand.value;
			case "bool":
				return operand.value;
			case "nil":
				return null;
			case "ident": {
				const fn = this.funcs[operand.name] ?? BUILTINS[operand.name];
				if (fn === undefined) {
					throw new Error(`${this.name}: function "${operand.name}" not defined`);
				}
				return fn();
			}
			case "pipe":
				return this.pipeline(operand.pipe, dot, scope);
		}
	}
}

/** Walks a dotted path, which is `.A.B` on whatever `.` currently is. */
function field(value: unknown, path: readonly string[]): unknown {
	let at = value;
	for (const name of path) {
		if (at === null || at === undefined) return undefined;
		if (at instanceof Map) {
			at = at.get(name);
			continue;
		}
		if (typeof at !== "object") return undefined;
		at = (at as Record<string, unknown>)[name];
	}
	return at;
}

// --- builtins -------------------------------------------------------------

/** Compares two values the way Go's `eq` does for basic kinds. */
function equal(a: unknown, b: unknown): boolean {
	if (typeof a === "number" && typeof b === "number") return a === b;
	if (typeof a === "string" && typeof b === "string") return a === b;
	if (typeof a === "boolean" && typeof b === "boolean") return a === b;
	if ((a ?? null) === null && (b ?? null) === null) return true;
	return a === b;
}

/** Orders two values, for `lt` and its siblings. */
function compare(a: unknown, b: unknown): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	const [x, y] = [String(a), String(b)];
	return x < y ? -1 : x > y ? 1 : 0;
}

const BUILTINS: Record<string, TemplateFunc> = {
	and: (...args) => {
		let last: unknown = true;
		for (const a of args) {
			last = a;
			if (!truthy(a)) return a;
		}
		return last;
	},
	or: (...args) => {
		let last: unknown = false;
		for (const a of args) {
			last = a;
			if (truthy(a)) return a;
		}
		return last;
	},
	not: (a) => !truthy(a),
	eq: (a, ...rest) => rest.some((b) => equal(a, b)),
	ne: (a, b) => !equal(a, b),
	lt: (a, b) => compare(a, b) < 0,
	le: (a, b) => compare(a, b) <= 0,
	gt: (a, b) => compare(a, b) > 0,
	ge: (a, b) => compare(a, b) >= 0,
	len: (a) => {
		if (typeof a === "string") return [...a].length;
		if (Array.isArray(a)) return a.length;
		if (a instanceof Map) return a.size;
		if (a !== null && typeof a === "object") return Object.keys(a).length;
		return 0;
	},
	index: (collection, ...keys) => {
		let at = collection;
		for (const key of keys) {
			if (Array.isArray(at)) {
				at = at[Number(key)];
			} else if (at instanceof Map) {
				at = at.get(key);
			} else if (at !== null && typeof at === "object") {
				at = (at as Record<string, unknown>)[String(key)];
			} else {
				return undefined;
			}
		}
		return at;
	},
	print: (...args) => args.map(stringify).join(""),
	println: (...args) => `${args.map(stringify).join(" ")}\n`,
	printf: (format, ...args) => sprintf(String(format), args),
};

/**
 * Go's `fmt.Sprintf`, for the verbs a template uses.
 *
 * `%d`, `%s`, `%v`, `%q`, `%c`, `%f` and `%%`, with an optional width and
 * precision and the `-`, `0` and `+` flags. A template that reaches past these
 * is outside the subset.
 */
export function sprintf(format: string, args: readonly unknown[]): string {
	let out = "";
	let arg = 0;
	let i = 0;

	while (i < format.length) {
		const ch = format[i] as string;
		if (ch !== "%") {
			out += ch;
			i++;
			continue;
		}

		const m = /^%([-+0 #]*)(\d*)(?:\.(\d+))?([a-zA-Z%])/.exec(format.slice(i));
		if (m === null) {
			out += ch;
			i++;
			continue;
		}

		const [whole, flags, widthText, precision, verb] = m as unknown as [
			string,
			string,
			string,
			string | undefined,
			string,
		];
		i += whole.length;

		if (verb === "%") {
			out += "%";
			continue;
		}

		const value = args[arg++];
		let text: string;
		switch (verb) {
			case "d":
				text = String(Math.trunc(Number(value) || 0));
				if (flags.includes("+") && Number(value) >= 0) text = `+${text}`;
				break;
			case "f":
				text = (Number(value) || 0).toFixed(
					precision === undefined ? 6 : Number(precision),
				);
				break;
			case "q":
				text = JSON.stringify(stringify(value));
				break;
			case "c":
				text =
					typeof value === "number"
						? String.fromCodePoint(value)
						: stringify(value);
				break;
			case "t":
				text = truthy(value) ? "true" : "false";
				break;
			default:
				text = stringify(value);
				if (precision !== undefined && verb === "s") {
					text = text.slice(0, Number(precision));
				}
		}

		const pad = Number(widthText || 0) - [...text].length;
		if (pad > 0) {
			const filler = flags.includes("0") && !flags.includes("-") ? "0" : " ";
			text = flags.includes("-")
				? text + " ".repeat(pad)
				: filler.repeat(pad) + text;
		}

		out += text;
	}

	return out;
}
