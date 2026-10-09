/**
 * How a file's extension decides which reader handles it.
 *
 * A file has three labels. Its *real* extension is what is on disk. Its
 * *normed* extension is the one Vale reads it as, which `[formats]` can
 * remap -- `qmd = md` makes a Quarto document read as Markdown. And its
 * *format* is the family that normed extension belongs to: `markup`, `code`,
 * `data` or `text`, which is what picks the reader.
 */

import { Glob } from "./glob.ts";
import { baseName, extName, toSlash } from "./util.ts";

/**
 * The files that hold a rule's test cases rather than a rule.
 *
 * A rule's cases live beside it, which puts them inside the `StylesPath`: the
 * loader that has to skip them and the runner that has to find them must agree
 * on which is which.
 */
export const TEST_FILE_SUFFIXES = [".test.yml", ".test.yaml"];

/** Whether a file name holds test cases rather than a rule. */
export function isTestFile(name: string): boolean {
	return TEST_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * The comment delimiters for the two languages with no bundled grammar.
 *
 * Everything else goes through tree-sitter. Clojure stays because no bundled
 * grammar uses `;` comments, and PowerShell because a stand-in grammar would
 * lose the interiors of its `<# #>` blocks.
 */
export const COMMENTS_BY_NORMED_EXT: Record<string, Record<string, string>> = {
	".clj": {
		inline: "(;+.+)",
		blockStart: "$^",
		blockEnd: "$^",
	},
	".ps1": {
		inline: "(#.+)",
		blockStart: "(<#.*)",
		blockEnd: "(.*#>)",
	},
};

/**
 * Each known extension's normed extension and format.
 *
 * The keys are patterns rather than plain extensions because several
 * extensions share a reader: `.cpp`, `.cc`, `.h` and the rest all read as
 * `.cpp`. The order they are tried in is the order written here.
 */
export const FORMAT_BY_EXTENSION: Array<[RegExp, [string, string]]> = [
	[/\.(?:[rc]?py[3w]?|[Ss][Cc]onstruct)$/, [".py", "code"]],
	[/\.(?:adoc|asciidoc|asc)$/, [".adoc", "markup"]],
	[/\.(?:clj|cljs|cljc|cljd)$/, [".clj", "code"]],
	[/\.(?:cpp|cc|c|cp|cxx|c\+\+|h|hpp|h\+\+)$/, [".cpp", "code"]],
	[/\.(?:css)$/, [".css", "code"]],
	[/\.(?:cs|csx)$/, [".cs", "code"]],
	[/\.(?:dita)$/, [".dita", "markup"]],
	[/\.(?:ex|exs)$/, [".ex", "code"]],
	[/\.(?:go)$/, [".go", "code"]],
	[/\.(?:hs)$/, [".hs", "code"]],
	[/\.(?:html|htm|shtml|xhtml)$/, [".html", "markup"]],
	[/\.(?:ipynb)$/, [".ipynb", "markup"]],
	[/\.(?:java|bsh)$/, [".java", "code"]],
	[/\.(?:jl)$/, [".jl", "code"]],
	[/\.(?:kt|kts)$/, [".kt", "code"]],
	[/\.(?:js|jsx)$/, [".js", "code"]],
	[/\.(?:lua)$/, [".lua", "code"]],
	[/\.(?:md|mdown|markdown|markdn|[Rr]md)$/, [".md", "markup"]],
	[/\.(?:mdx)$/, [".mdx", "markup"]],
	[/\.(?:myst)$/, [".myst", "markup"]],
	[/\.(?:qdoc|qdocinc)$/, [".qdoc", "markup"]],
	[/\.(?:qmd)$/, [".qmd", "markup"]],
	[/\.(?:qml)$/, [".qml", "code"]],
	[/\.(?:org)$/, [".org", "markup"]],
	[/\.(?:php)$/, [".php", "code"]],
	[/\.(?:pl|pm|pod)$/, [".r", "code"]],
	[/\.(?:proto)$/, [".proto", "code"]],
	[/\.(?:ps1|psm1|psd1)$/, [".ps1", "code"]],
	[/\.(?:rb|Gemfile|Rakefile|Brewfile|gemspec)$/, [".rb", "code"]],
	[/\.(?:rs)$/, [".rs", "code"]],
	[/\.(?:rst|rest)$/, [".rst", "markup"]],
	[/\.(?:r|R)$/, [".r", "code"]],
	[/\.(?:sass|scss|less)$/, [".c", "code"]],
	[/\.(?:scala|sbt)$/, [".c", "code"]],
	[/\.(?:swift)$/, [".c", "code"]],
	[/\.(?:ts|tsx)$/, [".ts", "code"]],
	[/\.(?:typ)$/, [".typ", "markup"]],
	[/\.(?:txt)$/, [".txt", "text"]],
	[/\.(?:xml|xsd)$/, [".xml", "markup"]],
	[/\.(?:yaml|yml)$/, [".yml", "data"]],
	[/\.(?:json)$/, [".json", "data"]],
	[/\.(?:toml)$/, [".toml", "data"]],
];

/**
 * The normed extension and format for a path.
 *
 * Returns `["unknown", "unknown"]` for an extension nothing recognizes, which
 * is how the linter decides to skip a file.
 */
export function formatFromExt(
	p: string,
	mapping: Record<string, string>,
): [string, string] {
	let base = extName(p).replace(/^\./, "");
	const kind = getFormat(`.${base}`);

	const mapped = formatFor(p, mapping);
	if (mapped !== null) {
		if (kind === "code" && getFormat(`.${mapped}`) === "markup") {
			// Markup embedded in code: the comments hold the prose.
			return [`.${mapped}`, "fragment"];
		}
		if (kind === "data" && getFormat(`.${mapped}`) === "markup") {
			// Markup embedded in data. Unlike code, a data format is always
			// read as a fragment, with plain text as the default.
			return [`.${mapped}`, "data"];
		}
		base = mapped;
	}

	const withDot = `.${base}`;
	for (const [pattern, result] of FORMAT_BY_EXTENSION) {
		if (pattern.test(withDot)) return [result[0], result[1]];
	}

	return ["unknown", "unknown"];
}

/**
 * The format `[formats]` maps a path to: by its extension, or by a key naming
 * the file or a glob it matches.
 */
export function formatFor(
	p: string,
	mapping: Record<string, string>,
): string | null {
	const ext = extName(p).replace(/^\./, "");
	const direct = mapping[ext];
	if (direct !== undefined) return direct;

	// Sorted so that two keys matching the same file always resolve the same
	// way, whatever order the configuration listed them in.
	const keys = Object.keys(mapping).sort();
	const name = baseName(p);
	const slashed = toSlash(p);

	for (const k of keys) {
		if (!/[*?[{/]/.test(k)) {
			if (k === name) return mapping[k]!;
			continue;
		}
		let pat: Glob;
		try {
			pat = Glob.compile(k);
		} catch {
			continue;
		}
		if (pat.match(name) || pat.match(slashed)) return mapping[k]!;
	}

	return null;
}

/**
 * The path with the extension `[formats]` maps it to, so that a section keyed
 * on a format matches the files read as it.
 */
export function normalizePathFormat(
	p: string,
	mapping: Record<string, string>,
): string {
	const format = formatFor(p, mapping);
	if (format === null) return p;
	const ext = extName(p);
	return `${ext === "" ? p : p.slice(0, -ext.length)}.${format}`;
}

/** The format family an extension belongs to, or "". */
export function getFormat(ext: string): string {
	for (const [pattern, result] of FORMAT_BY_EXTENSION) {
		if (pattern.test(ext)) return result[1];
	}
	return "";
}

/** The normed extension for an extension, or "". */
export function getNormedExt(ext: string): string {
	for (const [pattern, result] of FORMAT_BY_EXTENSION) {
		if (pattern.test(ext)) return result[0];
	}
	return "";
}
