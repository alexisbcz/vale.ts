/**
 * The languages Vale reads the comments of, and the grammars behind them.
 *
 * # The one asynchronous step
 *
 * `web-tree-sitter` compiles its WebAssembly, which cannot be done
 * synchronously, and every reader in this port is synchronous. So the
 * grammars are loaded once, eagerly, by `initCode`, and everything after that
 * is sync: `getLanguageFromExt` reads an already-loaded grammar out of a
 * table. `createLinterAsync` calls `initCode` for a caller who does not want
 * to think about it; a caller that builds its own linter calls it. Reaching a
 * source file before it has run throws, with that instruction in the message,
 * rather than silently reading no comments.
 *
 * # The grammars
 *
 * The grammars are the prebuilt ones from `tree-sitter-wasms`. Several
 * languages borrow another's: comments are extras in tree-sitter's sense and
 * survive error recovery, so a grammar that cannot parse the rest of the file
 * still finds every comment in it. That is how Go reads Haskell with the Elm
 * grammar, QML with JavaScript's, and R and Perl with Bash's.
 *
 * `web-tree-sitter` is pinned to 0.25.x rather than the current 0.27:
 * `tree-sitter-wasms` 0.1.13 was built with an older Emscripten, and 0.26 and
 * later refuse to load its modules. Within 0.25, two of the grammars Vale
 * would use are still unusable -- Elm, which Go parses Haskell with, and YAML,
 * whose module breaks the runtime's parse entry point for every file after it.
 * Both languages are read by the scanner instead.
 */

import type { Scope } from "@vale-ts/core";
import { getNormedExt } from "@vale-ts/core";
import { createRequire } from "node:module";
import { Language as Grammar, Parser } from "web-tree-sitter";
import {
	C_DIRECTIVE,
	CSHARP_DIRECTIVE,
	GO_DIRECTIVE,
	JAVA_DIRECTIVE,
	JS_DIRECTIVE,
	KOTLIN_DIRECTIVE,
	PY_DIRECTIVE,
	RUBY_DIRECTIVE,
	goDoc,
	goDocName,
	javadoc,
	jsDoc,
	kDoc,
	pyDoc,
	rustDoc,
} from "./doc.ts";
import type { Language, ScannerDelims } from "./types.ts";
import { C_STYLE_PREFIX, computePadding, cStyle } from "./util.ts";

/** The grammar file each extension is parsed with. */
const GRAMMARS: Readonly<Record<string, string>> = {
	".c": "c",
	".cpp": "cpp",
	".cs": "c_sharp",
	".css": "css",
	".ex": "elixir",
	".go": "go",
	".java": "java",
	".js": "javascript",
	".kt": "kotlin",
	".lua": "lua",
	".php": "php",
	".py": "python",
	// QML's object syntax is not valid JavaScript, but its comments are.
	".qml": "javascript",
	// R and Perl share a normed extension; all three use `#` line comments.
	".r": "bash",
	".rb": "ruby",
	".rs": "rust",
	".toml": "toml",
	".ts": "typescript",
	".tsx": "tsx",
};

/** Each loaded grammar, by its file's name. */
const loaded = new Map<string, Grammar>();

/** Whether `initCode` has run to completion. */
let ready = false;

/** The directory `tree-sitter-wasms` keeps its grammars in. */
function wasmDir(): string {
	const require_ = createRequire(import.meta.url);
	return require_
		.resolve("tree-sitter-wasms/package.json")
		.replace(/package\.json$/, "out/");
}

/**
 * Loads the tree-sitter runtime and every grammar Vale reads.
 *
 * Call this once before linting anything whose format is `code`, `fragment`,
 * or a data file a tree-sitter view reads. It is safe to call more than once.
 */
export async function initCode(): Promise<void> {
	if (ready) return;

	await Parser.init();

	const dir = wasmDir();
	const names = new Set(Object.values(GRAMMARS));
	for (const name of names) {
		if (loaded.has(name)) continue;
		loaded.set(name, await Grammar.load(`${dir}tree-sitter-${name}.wasm`));
	}

	ready = true;
}

/** Whether `initCode` has run. */
export function codeReady(): boolean {
	return ready;
}

/**
 * The comment delimiters of the languages with no usable grammar.
 *
 * `@vale-ts/core` carries the two Go has -- Clojure, because no bundled
 * grammar uses `;` comments, and PowerShell, because a stand-in would lose the
 * interiors of its `<# #>` blocks -- and these are the rest: Haskell and YAML,
 * whose grammars this build cannot load, and Julia and Protocol Buffers, which
 * `tree-sitter-wasms` does not ship at all.
 *
 * YAML is the one that needs more than a delimiter: a `#` inside a quoted
 * scalar, or inside the body of a block scalar, is content. See `scanner.ts`.
 *
 * A scanned comment has the same shape a captured one does, so everything
 * downstream -- dedenting, markup, alert placement -- is identical.
 *
 * The patterns match the delimiters alone rather than the whole line, as
 * `COMMENTS_BY_NORMED_EXT` does: the scanner looks for the closer after the
 * opener on the same line, which a whole-line opener would have swallowed.
 */
export const SCANNED: Readonly<Record<string, ScannerDelims>> = {
	".yml": {
		inline: /#.*/,
		blockStart: /$^/,
		blockEnd: /$^/,
		style: "yaml",
	},
	".clj": {
		inline: /;+.*/,
		blockStart: /$^/,
		blockEnd: /$^/,
	},
	".hs": {
		inline: /--.*/,
		blockStart: /\{-/,
		blockEnd: /-\}/,
	},
	".jl": {
		inline: /#(?!=).*/,
		blockStart: /#=/,
		blockEnd: /=#/,
	},
	".proto": {
		inline: /\/\/.*/,
		blockStart: /\/\*/,
		blockEnd: /\*\//,
	},
	".ps1": {
		inline: /#.*/,
		blockStart: /<#/,
		blockEnd: /#>/,
	},
};

function scope(expr: string, name = "", type = ""): Scope {
	return { name, expr, type };
}

/** The defaults a language definition fills in. */
function language(init: Partial<Language> & Pick<Language, "delims" | "queries" | "padding">): Language {
	return {
		prefix: null,
		cutset: "",
		directive: null,
		doc: null,
		docName: null,
		grammar: null,
		scanner: null,
		verbatim: null,
		...init,
	};
}

const COMMENT = [scope("(comment) @comment")];

/** Every language, by normed extension. */
function define(ext: string): Language | null {
	switch (ext) {
		case ".go":
			return language({
				delims: /\/\/|\/\*|\*\//,
				queries: COMMENT,
				padding: cStyle,
				// A doc comment opens with the name it documents and links to
				// others in brackets; a `//go:` line is a directive.
				directive: GO_DIRECTIVE,
				doc: goDoc,
				docName: goDocName,
			});
		case ".rs":
			return language({
				delims: /\/{2,3}!?/,
				queries: [scope("(line_comment)+ @comment")],
				padding: (s) => computePadding(s, ["//", "//!", "///"]),
				doc: rustDoc,
			});
		case ".py":
			return language({
				delims: /"""|'''|#/,
				queries: [
					scope("(comment)+ @comment"),
					// Function docstrings. The `#offset!` directive trims the
					// quotes; `delims` takes them off as well, so the result is the
					// same where a binding does not apply it.
					scope(`((function_definition
  body: (block . (expression_statement (string) @docstring)))
 (#offset! @docstring 0 3 0 -3))`),
					// Class docstrings.
					scope(`((class_definition
  body: (block . (expression_statement (string) @docstring)))
 (#offset! @docstring 0 3 0 -3))`),
					// Module docstrings.
					scope(`((module . (expression_statement (string) @docstring))
 (#offset! @docstring 0 3 0 -3))`),
				],
				padding: (s) => computePadding(s, ["#", '"""', "'''"]),
				directive: PY_DIRECTIVE,
				doc: pyDoc,
			});
		case ".rb":
			return language({
				delims: /=begin|=end|#/,
				queries: COMMENT,
				padding: (s) => computePadding(s, ["#", "=begin", "=end"]),
				directive: RUBY_DIRECTIVE,
			});
		case ".ex":
			// Elixir has no documentation comment syntax: its API documentation
			// lives in module attributes holding a string or a heredoc, and that
			// is what `mix docs` publishes and what a reader of the module reads
			// first. A comment-only pass sees the asides and none of the
			// documentation.
			//
			// They are given a `doc` meta scope -- `text.comment.doc.line` and
			// `text.comment.doc.block` -- so that published documentation can be
			// held to a different standard than an implementation note, or
			// excluded on its own.
			return language({
				delims: /#/,
				queries: [
					scope("(comment) @comment"),
					// `@` applied to a call whose target names a documentation
					// attribute and whose argument is a string or sigil.
					//
					// The attribute name is tested through `@_attr`, a
					// predicate-only capture, so that the prose can be captured on
					// its own. `quoted_content` is bare prose -- the capture is
					// named `prose`, so no delimiter stripping touches it and a
					// `## Examples` heading keeps its markers. `@doc false` and
					// `@doc since: "1.0"` carry no prose, and neither matches a
					// query that requires a string or sigil.
					scope(
						`((unary_operator
  operand: (call
    target: (identifier) @_attr
    (arguments [
      (string (quoted_content) @prose)
      (sigil (quoted_content) @prose)
    ])))
 (#match? @_attr "^(module|type|short)?doc$"))`,
						"doc",
					),
				],
				padding: (s) => computePadding(s, ["#"]),
			});
		case ".cpp":
			return language({
				delims: /\/\*!?|\/\/|\*\//,
				prefix: C_STYLE_PREFIX,
				queries: COMMENT,
				padding: cStyle,
				directive: C_DIRECTIVE,
			});
		case ".c":
			return language({
				delims: /\/\/|\/\*|\*\//,
				prefix: C_STYLE_PREFIX,
				queries: COMMENT,
				padding: cStyle,
				directive: C_DIRECTIVE,
			});
		case ".cs":
			// `//` line comments, `///` XML documentation comments and `/* */`
			// block comments, all of which the grammar parses as `comment`.
			return language({
				delims: /\/\/\/?|\/\*|\*\//,
				prefix: C_STYLE_PREFIX,
				queries: COMMENT,
				// `///` is listed so that a documentation comment's padding
				// matches what `delims` takes off; `cStyle` alone stops at `//`.
				padding: (s) => computePadding(s, ["//", "///", "/*"]),
				directive: CSHARP_DIRECTIVE,
				// C# 11 raw string literals postdate the bundled grammar, which
				// reads the `//` inside one as a comment.
				verbatim: /"""[\s\S]*?"""/g,
			});
		case ".js":
			// A cutset of " *" was tried here and cannot work: it makes the
			// dedent read `*` as indentation, which eats a Markdown list, and
			// the alert adjustment has no way to know a non-whitespace character
			// was removed. `prefix` handles the decoration instead.
			return language({
				delims: /\/\*\*?|\/\/|\*\//,
				prefix: C_STYLE_PREFIX,
				queries: COMMENT,
				padding: cStyle,
				directive: JS_DIRECTIVE,
				doc: jsDoc,
			});
		case ".hs":
			return language({
				delims: /\{-\|?|-\}|--/,
				queries: [],
				padding: (s) => computePadding(s, ["--", "{-"]),
				scanner: SCANNED[".hs"],
			});
		case ".jl":
			return language({
				delims: /#=|=#|#/,
				queries: [],
				padding: (s) => computePadding(s, ["#", "#=", "=#"]),
				scanner: SCANNED[".jl"],
			});
		case ".java":
			return language({
				delims: /\/\/|\/\*|\*\//,
				prefix: C_STYLE_PREFIX,
				queries: [
					scope("(line_comment)+ @comment"),
					scope("(block_comment)+ @comment"),
				],
				padding: cStyle,
				directive: JAVA_DIRECTIVE,
				doc: javadoc,
			});
		case ".kt":
			// `//` line comments and `/* */` block comments, including KDoc
			// (`/** */`), which the grammar parses as an ordinary block comment.
			return language({
				delims: /\/\*\*?|\/\/|\*\//,
				prefix: C_STYLE_PREFIX,
				queries: [
					scope("(line_comment)+ @comment"),
					scope("(multiline_comment) @comment"),
				],
				// `/**` is listed so that a one-line KDoc comment's padding
				// matches what `delims` takes off; `cStyle` alone stops at `/*`.
				padding: (s) => computePadding(s, ["//", "/*", "/**"]),
				directive: KOTLIN_DIRECTIVE,
				doc: kDoc,
			});
		case ".lua":
			// The bundled grammar has no `emmy_documentation` node, so a `---`
			// doc comment arrives as an ordinary `comment`, which is what the one
			// query below collects.
			return language({
				delims: /--\[=*\[|\]=*\]|--/,
				queries: COMMENT,
				padding: (s) => computePadding(s, ["--", "--[["]),
			});
		case ".php":
			return language({
				delims: /\/\*\*?|\/\/|\*\/|#/,
				prefix: C_STYLE_PREFIX,
				queries: COMMENT,
				padding: (s) => computePadding(s, ["//", "/*", "#"]),
			});
		case ".ts":
			return language({
				delims: /\/\/|\/\*|\*\//,
				prefix: C_STYLE_PREFIX,
				queries: COMMENT,
				padding: cStyle,
				directive: JS_DIRECTIVE,
				doc: jsDoc,
			});
		case ".tsx":
			return language({
				delims: /\/\/|\/\*|\*\//,
				prefix: C_STYLE_PREFIX,
				queries: COMMENT,
				padding: cStyle,
				directive: JS_DIRECTIVE,
				doc: jsDoc,
			});
		case ".proto":
			return language({
				delims: /\/\/|\/\*|\*\//,
				queries: [],
				padding: cStyle,
				scanner: SCANNED[".proto"],
			});
		case ".qml":
			return language({
				delims: /\/\*[!*]?|\/\/|\*\//,
				prefix: C_STYLE_PREFIX,
				queries: COMMENT,
				padding: cStyle,
			});
		case ".r":
			return language({
				delims: /#'|#/,
				queries: COMMENT,
				padding: (s) => computePadding(s, ["#", "#'"]),
			});
		case ".clj":
			return language({
				delims: /;+/,
				queries: [],
				padding: (s) => computePadding(s, [";"]),
				scanner: SCANNED[".clj"],
			});
		case ".ps1":
			return language({
				delims: /<#|#>|#/,
				queries: [],
				padding: (s) => computePadding(s, ["#", "<#"]),
				scanner: SCANNED[".ps1"],
			});
		case ".yml":
		case ".yaml":
			return language({
				delims: /#/,
				queries: [],
				padding: (s) => computePadding(s, ["#"]),
				scanner: SCANNED[".yml"],
			});
		case ".toml":
			// A `#` inside a string is not a comment, which is what the grammar
			// knows and a pattern does not.
			return language({
				delims: /#/,
				queries: COMMENT,
				padding: (s) => computePadding(s, ["#"]),
			});
		case ".css":
			return language({
				delims: /\/\*!?|\*\//,
				queries: COMMENT,
				padding: (s) => computePadding(s, ["/*"]),
			});
		default:
			return null;
	}
}

/**
 * The language for a file extension.
 *
 * A fresh definition each call, whose queries a view may replace; the grammar
 * underneath is the one loaded by `initCode`, so a query compiled against it
 * stays cached.
 */
export function getLanguageFromExt(ext: string): Language {
	const normed = getNormedExt(ext) === "" ? ext : getNormedExt(ext);
	const lang = define(normed);
	if (lang === null) {
		throw new Error(`unsupported extension: '${ext}'`);
	}

	if (lang.scanner !== null) return lang;

	const name = GRAMMARS[normed];
	if (name === undefined) {
		throw new Error(`unsupported extension: '${ext}'`);
	}
	const grammar = loaded.get(name);
	if (grammar === undefined) {
		throw new Error(
			`the tree-sitter grammars are not loaded; await initCode() before linting '${ext}' files`,
		);
	}

	lang.grammar = grammar;
	return lang;
}

/** Whether Vale can read the comments of a file with this extension. */
export function hasLanguage(ext: string): boolean {
	const normed = getNormedExt(ext) === "" ? ext : getNormedExt(ext);
	return define(normed) !== null;
}
