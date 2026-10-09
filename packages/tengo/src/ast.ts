/**
 * The syntax tree, one node per production Tengo's parser has.
 *
 * Nodes are plain tagged records rather than classes: the interpreter walks
 * them with a `switch` on `kind`, and TypeScript narrows each case from the
 * tag alone. Every node carries `at`, the source offset it starts at, which is
 * the only thing a runtime error has to point at.
 */

import type { TokenKind } from "./lexer.ts";

export interface IntLit {
	kind: "int";
	at: number;
	value: number;
}

export interface FloatLit {
	kind: "float";
	at: number;
	value: number;
}

export interface StringLit {
	kind: "string";
	at: number;
	value: string;
}

export interface CharLit {
	kind: "char";
	at: number;
	value: number;
}

export interface BoolLit {
	kind: "bool";
	at: number;
	value: boolean;
}

export interface UndefinedLit {
	kind: "undefinedLit";
	at: number;
}

export interface Ident {
	kind: "ident";
	at: number;
	name: string;
}

export interface ArrayLit {
	kind: "arrayLit";
	at: number;
	elements: Expr[];
}

export interface MapLit {
	kind: "mapLit";
	at: number;
	entries: Array<{ key: string; value: Expr }>;
}

export interface FuncLit {
	kind: "funcLit";
	at: number;
	params: string[];
	/** Whether the last parameter collects the remaining arguments. */
	variadic: boolean;
	body: BlockStmt;
}

export interface UnaryExpr {
	kind: "unary";
	at: number;
	op: "+" | "-" | "!" | "^";
	operand: Expr;
}

export interface BinaryExpr {
	kind: "binary";
	at: number;
	op: TokenKind;
	left: Expr;
	right: Expr;
}

export interface CondExpr {
	kind: "cond";
	at: number;
	test: Expr;
	then: Expr;
	otherwise: Expr;
}

export interface IndexExpr {
	kind: "index";
	at: number;
	target: Expr;
	index: Expr;
}

export interface SliceExpr {
	kind: "slice";
	at: number;
	target: Expr;
	low: Expr | null;
	high: Expr | null;
}

export interface SelectorExpr {
	kind: "selector";
	at: number;
	target: Expr;
	name: string;
}

export interface CallExpr {
	kind: "call";
	at: number;
	callee: Expr;
	args: Expr[];
	/** Whether the last argument is spread with `...`. */
	spread: boolean;
}

export interface ImportExpr {
	kind: "import";
	at: number;
	module: string;
}

export interface ErrorExpr {
	kind: "errorExpr";
	at: number;
	value: Expr;
}

export interface ImmutableExpr {
	kind: "immutableExpr";
	at: number;
	value: Expr;
}

export type Expr =
	| IntLit
	| FloatLit
	| StringLit
	| CharLit
	| BoolLit
	| UndefinedLit
	| Ident
	| ArrayLit
	| MapLit
	| FuncLit
	| UnaryExpr
	| BinaryExpr
	| CondExpr
	| IndexExpr
	| SliceExpr
	| SelectorExpr
	| CallExpr
	| ImportExpr
	| ErrorExpr
	| ImmutableExpr;

export interface ExprStmt {
	kind: "exprStmt";
	at: number;
	expr: Expr;
}

export interface AssignStmt {
	kind: "assign";
	at: number;
	/** `:=`, `=`, or one of the compound forms such as `+=`. */
	op: TokenKind;
	target: Expr;
	value: Expr;
}

export interface IncDecStmt {
	kind: "incDec";
	at: number;
	op: "++" | "--";
	target: Expr;
}

export interface BlockStmt {
	kind: "block";
	at: number;
	body: Stmt[];
}

export interface IfStmt {
	kind: "if";
	at: number;
	init: Stmt | null;
	cond: Expr;
	then: BlockStmt;
	otherwise: Stmt | null;
}

export interface ForStmt {
	kind: "for";
	at: number;
	init: Stmt | null;
	cond: Expr | null;
	post: Stmt | null;
	body: BlockStmt;
}

export interface ForInStmt {
	kind: "forIn";
	at: number;
	/** `"_"` when the loop names only a value. */
	key: string;
	value: string;
	iterable: Expr;
	body: BlockStmt;
}

export interface BranchStmt {
	kind: "branch";
	at: number;
	op: "break" | "continue";
}

export interface ReturnStmt {
	kind: "return";
	at: number;
	value: Expr | null;
}

export interface ExportStmt {
	kind: "export";
	at: number;
	value: Expr;
}

export interface EmptyStmt {
	kind: "empty";
	at: number;
}

export type Stmt =
	| ExprStmt
	| AssignStmt
	| IncDecStmt
	| BlockStmt
	| IfStmt
	| ForStmt
	| ForInStmt
	| BranchStmt
	| ReturnStmt
	| ExportStmt
	| EmptyStmt;

/** A parsed program: the top-level statement list. */
export interface Program {
	body: Stmt[];
}

/** Walks every node under `node`, children first being irrelevant here. */
export function walk(node: Stmt | Expr, visit: (n: Stmt | Expr) => void): void {
	visit(node);
	for (const child of children(node)) walk(child, visit);
}

function children(node: Stmt | Expr): Array<Stmt | Expr> {
	switch (node.kind) {
		case "arrayLit":
			return node.elements;
		case "mapLit":
			return node.entries.map((e) => e.value);
		case "funcLit":
			return [node.body];
		case "unary":
			return [node.operand];
		case "binary":
			return [node.left, node.right];
		case "cond":
			return [node.test, node.then, node.otherwise];
		case "index":
			return [node.target, node.index];
		case "slice":
			return [node.target, node.low, node.high].filter(nonNull);
		case "selector":
			return [node.target];
		case "call":
			return [node.callee, ...node.args];
		case "errorExpr":
		case "immutableExpr":
			return [node.value];
		case "exprStmt":
			return [node.expr];
		case "assign":
			return [node.target, node.value];
		case "incDec":
			return [node.target];
		case "block":
			return node.body;
		case "if":
			return [node.init, node.cond, node.then, node.otherwise].filter(nonNull);
		case "for":
			return [node.init, node.cond, node.post, node.body].filter(nonNull);
		case "forIn":
			return [node.iterable, node.body];
		case "return":
			return node.value === null ? [] : [node.value];
		case "export":
			return [node.value];
		default:
			return [];
	}
}

function nonNull<T>(x: T | null): x is T {
	return x !== null;
}
