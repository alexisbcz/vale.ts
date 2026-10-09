/**
 * The small helpers the rest of the port shares.
 *
 * # Offsets, characters and columns
 *
 * Go counts bytes in some places and runes in others, and converts between
 * them. This port has one offset unit -- the JavaScript string index, a UTF-16
 * code unit -- so nothing converts. Columns are the exception: a column is a
 * count of characters, which is what `strLen` returns.
 */

/** The number of characters in `s`, which is what a column counts. */
export function strLen(s: string): number {
	// Counting code points rather than code units, so an astral character
	// occupies one column, as it does under Go's rune count.
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		n++;
		const code = s.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i++;
		}
	}
	return n;
}

/** Upper-cases the first character. */
export function capFirst(s: string): string {
	if (s.length === 0) return s;
	return s[0]!.toUpperCase() + s.slice(1);
}

const ANSI =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point.
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-ntqry=><~]))/g;

/** Removes every ANSI escape sequence. */
export function stripANSI(s: string): string {
	return s.replace(ANSI, "");
}

/** How many characters the `&rsquo;` rewrite removes. */
export const RSQUO_SHIFT = "&rsquo;".length - "'".length;

/**
 * Prepares text for the checks: normalizes line endings and the one HTML
 * entity Vale rewrites.
 */
export function sanitize(txt: string): string {
	return txt
		.replaceAll("&rsquo;", "'")
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n");
}

/**
 * Records, per 1-based line, the column of each rewrite that shortened the
 * text, so a reported span can be mapped back to the file as written.
 *
 * Only `&rsquo;` changes a line's width; the line-ending rewrites do not move
 * columns.
 */
export function findShifts(raw: string): Map<number, number[]> | null {
	if (!raw.includes("&rsquo;")) return null;

	const shifts = new Map<number, number[]>();
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		let at = 0;
		for (;;) {
			const j = line.indexOf("&rsquo;", at);
			if (j < 0) break;
			at = j;
			const col = strLen(sanitize(line.slice(0, at))) + 1;
			const row = i + 1;
			const existing = shifts.get(row);
			if (existing) existing.push(col);
			else shifts.set(row, [col]);
			at += "&rsquo;".length;
		}
	}
	return shifts;
}

/** Joins terms into a sentence: `'a', 'b', or 'c'`. */
export function toSentence(words: string[], andOrOr: string): string {
	const l = words.length;
	if (l === 0) return "";
	if (l === 1) return `'${words[0]}'`;
	if (l === 2) return `'${words[0]}' ${andOrOr} '${words[1]}'`;

	const quoted = words.map((w) => `'${w}'`);
	quoted[l - 1] = `${andOrOr} ${quoted[l - 1]}`;
	return quoted.join(", ");
}

/** Whether every character is a letter. */
export function isLetter(s: string): boolean {
	for (const r of s) {
		if (!/\p{L}/u.test(r)) return false;
	}
	return true;
}

/** Whether `s` looks like a code token rather than prose. */
export function isCode(s: string): boolean {
	for (const r of s) {
		if (r !== "*" && r !== "@") return false;
	}
	return true;
}

/**
 * Whether `s` is a plain phrase rather than a pattern.
 *
 * Used to tell a rule's literal tokens from its regular expressions.
 */
export function isPhrase(s: string): boolean {
	for (const r of s) {
		if (!/[\p{L}\p{Nd}]/u.test(r) && r !== " " && r !== "-") return false;
	}
	return true;
}

/** Whether the two-element range `r` contains `n`. */
export function inRange(n: number, r: number[]): boolean {
	return r.length === 2 && r[0]! <= n && n <= r[1]!;
}

/**
 * Fills `%s` placeholders in `msg` with `subs`, ignoring any extras.
 *
 * Go's `fmt.Sprintf` is what the rules were written against, so a message with
 * fewer placeholders than arguments has to come out unchanged rather than
 * gaining a `%!(EXTRA ...)` tail -- which is what `CondSprintf` arranges there.
 */
export function formatMessage(msg: string, ...subs: string[]): string {
	let i = 0;
	return msg.replace(/%(%|s|v|d|q|\[\d+\][svdq])/g, (m) => {
		if (m === "%%") return "%";
		const indexed = /^%\[(\d+)\]/.exec(m);
		if (indexed) {
			const at = Number.parseInt(indexed[1]!, 10) - 1;
			return subs[at] ?? "";
		}
		const sub = subs[i++];
		if (sub === undefined) return "";
		return m === "%q" ? JSON.stringify(sub) : sub;
	});
}

/**
 * Replaces the first occurrence of `sub` with a run of `char`, keeping any
 * newlines so that positions after it do not move.
 */
export function substitute(
	src: string,
	sub: string,
	char: string,
): [string, boolean] {
	const idx = src.indexOf(sub);
	if (idx < 0) return [src, false];
	let repl = "";
	for (const r of sub) repl += r === "\n" ? "\n" : char;
	return [src.slice(0, idx) + repl + src.slice(idx + sub.length), true];
}

/** Indents every line of `text`. */
export function indent(text: string, prefix: string): string {
	if (text === "") return text;
	if (text.endsWith("\n")) {
		return `${text
			.slice(0, -1)
			.split("\n")
			.map((l) => prefix + l)
			.join("\n")}\n`;
	}
	return text
		.replace(/\n+$/, "")
		.split("\n")
		.map((l) => prefix + l)
		.join("\n");
}

/**
 * The style a rule belongs to: `proselint` for `proselint.Typography`.
 *
 * A configuration may name either, so a setting can be given once for a style
 * and then overridden for one rule within it.
 */
export function styleName(rule: string): string {
	const dot = rule.indexOf(".");
	return dot < 0 ? rule : rule.slice(0, dot);
}

/**
 * Derives a rule's name from where it sits under its style root.
 *
 * `Std/dates/TimeFormat.yml` is `Std.dates.TimeFormat`: the tree is part of
 * the name, so organizing a style never silently renames a rule, and disabling
 * one names the path you see on disk. The file's base keeps its historical
 * reading of everything before the first dot, so `Terms.custom.yml` is still
 * `Terms`.
 */
export function checkName(styleRoot: string, rulePath: string): string {
	const rel = relativePath(styleRoot, rulePath);
	const parts = rel.split("/").filter((p) => p !== "");
	const last = parts[parts.length - 1] ?? "";
	parts[parts.length - 1] = last.split(".")[0] ?? last;

	const name = `${baseName(styleRoot)}.${parts.join(".")}`;
	if (name.includes("[") || name.includes("]")) {
		// `Style.Rule[param]` is configuration syntax; a name holding brackets
		// would make every such key ambiguous.
		throw new Error(`'${name}' contains brackets, which rule names cannot`);
	}
	return name;
}

/** The last path element, with any trailing separator ignored. */
export function baseName(p: string): string {
	const norm = p.replace(/[/\\]+$/, "");
	const i = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
	return i < 0 ? norm : norm.slice(i + 1);
}

/** The path without its last element. */
export function dirName(p: string): string {
	const norm = p.replace(/[/\\]+$/, "");
	const i = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
	if (i < 0) return ".";
	if (i === 0) return "/";
	return norm.slice(0, i);
}

/** The file's extension, dot included, or "". */
export function extName(p: string): string {
	const base = baseName(p);
	const i = base.lastIndexOf(".");
	return i <= 0 ? "" : base.slice(i);
}

/** `to` expressed relative to `from`, with forward slashes. */
export function relativePath(from: string, to: string): string {
	const a = toSlash(from).replace(/\/+$/, "").split("/");
	const b = toSlash(to).split("/");
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const up = a.slice(i).map(() => "..");
	return [...up, ...b.slice(i)].join("/");
}

/** The path with every backslash turned into a forward slash. */
export function toSlash(p: string): string {
	return p.replaceAll("\\", "/");
}

/** Joins path elements, collapsing `.` and `..`. */
export function joinPath(...parts: string[]): string {
	const kept = parts.filter((p) => p !== "");
	if (kept.length === 0) return "";
	const absolute = kept[0]!.startsWith("/");
	const out: string[] = [];
	for (const part of kept) {
		for (const seg of toSlash(part).split("/")) {
			if (seg === "" || seg === ".") continue;
			if (seg === "..") {
				if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
				else if (!absolute) out.push("..");
				continue;
			}
			out.push(seg);
		}
	}
	const joined = out.join("/");
	if (absolute) return `/${joined}`;
	return joined === "" ? "." : joined;
}

/** Whether the path is absolute. */
export function isAbsolute(p: string): boolean {
	return p.startsWith("/") || /^[A-Za-z]:[/\\]/.test(p);
}

/** Removes duplicates, keeping the first of each. */
export function uniqueStrings(slice: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of slice) {
		if (!seen.has(entry)) {
			seen.add(entry);
			out.push(entry);
		}
	}
	return out;
}

/** Whether `s` ends with one of `suffixes`, which must not be all of `s`. */
export function hasAnySuffix(s: string, suffixes: readonly string[]): boolean {
	for (const suffix of suffixes) {
		if (s.length > suffix.length && s.endsWith(suffix)) return true;
	}
	return false;
}

/** The directories a walk skips without being told to. */
export const DEFAULT_IGNORE_DIRECTORIES = ["node_modules", ".git"];

/** Whether a directory is one a walk skips. */
export function shouldIgnoreDirectory(directoryPath: string): boolean {
	const name = baseName(directoryPath);
	if (name === ".") return false;
	return DEFAULT_IGNORE_DIRECTORIES.includes(name);
}

/**
 * Splits text into lines, keeping the newline on the end of each.
 *
 * Go's `strings.SplitAfter(s, "\n")` leaves a final empty element when the
 * text ends in a newline; several of the location calculations count on that,
 * so it is kept.
 */
export function splitAfterLines(s: string): string[] {
	const out: string[] = [];
	let start = 0;
	for (;;) {
		const i = s.indexOf("\n", start);
		if (i < 0) {
			out.push(s.slice(start));
			return out;
		}
		out.push(s.slice(start, i + 1));
		start = i + 1;
	}
}
