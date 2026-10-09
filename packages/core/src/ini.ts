/**
 * The INI reader `.vale.ini` is written for.
 *
 * Vale uses `errata-ai/ini` with shadows enabled, which is the feature the
 * configuration pipeline is built on: when several files set the same key, the
 * values stack up rather than replacing one another, and the loader decides
 * which layer wins by reading the list from either end. Everything here exists
 * to reproduce that, plus the handful of lexical details a real configuration
 * file depends on -- inline comments needing a space in front of them, values
 * continuing over a trailing backslash, `%(key)s` interpolation.
 */

/** The name the top-level, section-less keys live under. */
export const DEFAULT_SECTION = "DEFAULT";

/** How many times `%(key)s` interpolation will chase a reference. */
const INTERPOLATION_DEPTH = 99;

const VAR_PATTERN = /%\(([^)]*)\)s/;

export interface LoadOptions {
	/** Keep every value a key is given rather than only the last. */
	allowShadows?: boolean;
	/** An inline comment needs a space before its `#` or `;`. */
	spaceBeforeInlineComment?: boolean;
	/** Read a trailing `\` as continuing the value onto the next line. */
	ignoreContinuation?: boolean;
	/** Do not treat a `#` or `;` in a value as starting a comment. */
	ignoreInlineComment?: boolean;
}

export class Key {
	readonly name: string;
	/** The value as written, before interpolation. */
	value: string;
	/** The values later layers added, in the order they arrived. */
	readonly shadows: string[] = [];
	/** The comment that was attached to the key. */
	comment = "";

	private readonly section: Section;

	constructor(section: Section, name: string, value: string) {
		this.section = section;
		this.name = name;
		this.value = value;
	}

	/** The value with `%(key)s` references resolved. */
	string(): string {
		return this.transform(this.value);
	}

	/** The value with a fallback for a key that was never set. */
	mustString(def: string): string {
		const v = this.string();
		return v === "" ? def : v;
	}

	/** Every value the key was given, earliest first. */
	valueWithShadows(): string[] {
		if (this.shadows.length === 0) return [this.value];
		return [this.value, ...this.shadows];
	}

	/**
	 * Adds a value from a later layer.
	 *
	 * A value identical to one already held is dropped, which is what keeps a
	 * key repeated across two files from showing up twice.
	 */
	addShadow(val: string): void {
		if (this.value === val) return;
		if (this.shadows.includes(val)) return;
		this.shadows.push(val);
	}

	setValue(val: string): void {
		this.value = val;
		this.shadows.length = 0;
	}

	/**
	 * The value split on `delim`, with each piece trimmed.
	 *
	 * An escaped delimiter stays in its piece, which is how a pattern holding a
	 * `{2,}` quantifier survives being read as a comma-separated list.
	 */
	strings(delim: string): string[] {
		const str = this.string();
		if (str.length === 0) return [];

		const runes = [...str];
		const vals: string[] = [];
		let buf = "";
		let escape = false;

		for (let idx = 0; idx < runes.length; idx++) {
			const r = runes[idx]!;
			if (escape) {
				escape = false;
				if (r !== "\\" && !runes.slice(idx).join("").startsWith(delim)) {
					buf += "\\";
				}
				buf += r;
				continue;
			}
			if (r === "\\") {
				escape = true;
				continue;
			}
			if (runes.slice(idx).join("").startsWith(delim)) {
				idx += delim.length - 1;
				vals.push(buf.trim());
				buf = "";
				continue;
			}
			buf += r;
		}

		if (buf.length > 0) vals.push(buf.trim());
		return vals;
	}

	/**
	 * Every value, each split on `delim`.
	 *
	 * Unlike `strings`, this does not honour an escaped delimiter -- which is
	 * the library's behaviour, and why Vale splits some keys itself.
	 */
	stringsWithShadows(delim: string): string[] {
		const out: string[] = [];
		for (const v of this.valueWithShadows()) {
			for (const piece of v.split(delim)) {
				out.push(this.transform(piece.trim()));
			}
		}
		return out;
	}

	private transform(val: string): string {
		if (!val.includes("%")) return val;
		let out = val;
		for (let i = 0; i < INTERPOLATION_DEPTH; i++) {
			const m = VAR_PATTERN.exec(out);
			if (m === null) break;
			const name = m[1]!;
			let target = this.section.getKey(name);
			if (target === undefined || target === this) {
				target = this.section.file.section("").getKey(name);
				if (target === undefined) break;
			}
			out = out.replaceAll(m[0], target.value);
		}
		return out;
	}
}

export class Section {
	readonly name: string;
	readonly file: File;
	comment = "";

	private readonly order: string[] = [];
	private readonly byName = new Map<string, Key>();

	constructor(file: File, name: string) {
		this.file = file;
		this.name = name;
	}

	/** The key names, in the order they first appeared. */
	keyStrings(): string[] {
		return this.order.slice();
	}

	keys(): Key[] {
		return this.order.map((n) => this.byName.get(n)!);
	}

	hasKey(name: string): boolean {
		return this.byName.has(name);
	}

	getKey(name: string): Key | undefined {
		return this.byName.get(name);
	}

	/** The named key, created empty if it does not exist. */
	key(name: string): Key {
		const existing = this.byName.get(name);
		if (existing !== undefined) return existing;
		const k = new Key(this, name, "");
		// Not registered: asking about a key must not invent one, which is what
		// `Section.Key` does in the Go library too.
		return k;
	}

	/**
	 * Records a value for `name`.
	 *
	 * With shadows on, a second value for a key already present is added to it
	 * rather than replacing it.
	 */
	newKey(name: string, val: string): Key {
		const existing = this.byName.get(name);
		if (existing !== undefined) {
			if (this.file.options.allowShadows) existing.addShadow(val);
			else existing.value = val;
			return existing;
		}
		const k = new Key(this, name, val);
		this.order.push(name);
		this.byName.set(name, k);
		return k;
	}

	deleteKey(name: string): void {
		const at = this.order.indexOf(name);
		if (at >= 0) this.order.splice(at, 1);
		this.byName.delete(name);
	}
}

export class File {
	readonly options: LoadOptions;

	private readonly order: string[] = [];
	private readonly byName = new Map<string, Section>();

	constructor(options: LoadOptions = {}) {
		this.options = options;
		this.newSection(DEFAULT_SECTION);
	}

	/** The section names, in the order they first appeared. */
	sectionStrings(): string[] {
		return this.order.slice();
	}

	sections(): Section[] {
		return this.order.map((n) => this.byName.get(n)!);
	}

	/** The named section, created empty if it does not exist. */
	section(name: string): Section {
		const key = name === "" ? DEFAULT_SECTION : name;
		const existing = this.byName.get(key);
		if (existing !== undefined) return existing;
		return this.newSection(key);
	}

	getSection(name: string): Section | undefined {
		return this.byName.get(name === "" ? DEFAULT_SECTION : name);
	}

	newSection(name: string): Section {
		const key = name === "" ? DEFAULT_SECTION : name;
		const existing = this.byName.get(key);
		if (existing !== undefined) return existing;
		const s = new Section(this, key);
		this.order.push(key);
		this.byName.set(key, s);
		return s;
	}
}

/** Parses INI text into a `File`. */
export function parseINI(source: string, options: LoadOptions = {}): File {
	const file = new File(options);
	loadInto(file, source);
	return file;
}

/** An empty `File`, for a caller that will merge sources into it. */
export function emptyINI(options: LoadOptions = {}): File {
	return new File(options);
}

/**
 * Reads INI text into an existing `File`, so several sources can stack up
 * their values as shadows on the same keys.
 */
export function loadInto(file: File, source: string): void {
	const parser = new Parser(source, file.options);
	let section = file.section(DEFAULT_SECTION);
	let comment = "";

	for (;;) {
		const raw = parser.nextLine();
		if (raw === null) break;

		const line = raw.replace(/^\s+/, "");
		if (line.length === 0) continue;

		if (line[0] === "#" || line[0] === ";") {
			comment += line;
			continue;
		}

		if (line[0] === "[") {
			const close = line.lastIndexOf("]");
			if (close === -1) {
				throw new Error(`unclosed section: ${line}`);
			}
			const name = line.slice(1, close);
			section = file.newSection(name);
			const tail = cleanComment(line.slice(close + 1));
			if (tail !== null) comment += tail;
			section.comment = comment.trim();
			comment = "";
			continue;
		}

		const named = readKeyName(line);
		if (named === null) {
			// A line with no delimiter is not a key. The Go library errors
			// here; a configuration file that has carried such a line for years
			// should still lint, so it is skipped.
			continue;
		}

		const value = parser.readValue(line.slice(named.offset));
		const key = section.newKey(named.name, value.text);
		key.comment = (comment + value.comment).trim();
		comment = "";
	}
}

/** Where a key's name ends and its value begins, or null for a non-key line. */
function readKeyName(line: string): { name: string; offset: number } | null {
	// A quoted name, so that a key may hold a delimiter.
	let quote = "";
	if (line[0] === '"') quote = line.startsWith('"""') ? '"""' : '"';
	else if (line[0] === "`") quote = "`";

	if (quote !== "") {
		const start = quote.length;
		const pos = line.indexOf(quote, start);
		if (pos === -1) {
			throw new Error(`missing closing key quote: ${line}`);
		}
		const i = indexOfAny(line.slice(pos + start), "=:");
		if (i < 0) return null;
		return { name: line.slice(start, pos).trim(), offset: pos + start + i + 1 };
	}

	const end = indexOfAny(line, "=:");
	if (end < 0) return null;
	return { name: line.slice(0, end).trim(), offset: end + 1 };
}

function indexOfAny(s: string, chars: string): number {
	for (let i = 0; i < s.length; i++) {
		if (chars.includes(s[i]!)) return i;
	}
	return -1;
}

function cleanComment(s: string): string | null {
	const i = indexOfAny(s, "#;");
	return i === -1 ? null : s.slice(i);
}

class Parser {
	private readonly lines: string[];
	private at = 0;
	private readonly options: LoadOptions;

	constructor(source: string, options: LoadOptions) {
		// Keeping the newline on each line matters only for a value that
		// continues, and the continuation reader trims anyway.
		this.lines = source.split("\n");
		this.options = options;
	}

	nextLine(): string | null {
		if (this.at >= this.lines.length) return null;
		return this.lines[this.at++]!;
	}

	/**
	 * Reads the value half of a key line.
	 *
	 * Handles the three quoting forms, a value continued over a trailing
	 * backslash, and an inline comment -- which, with
	 * `spaceBeforeInlineComment`, has to have a space in front of it so that a
	 * `#` inside a pattern stays part of the value.
	 */
	readValue(input: string): { text: string; comment: string } {
		let line = input.replace(/^\s+/, "");
		if (line.length === 0) return { text: "", comment: "" };

		let valQuote = "";
		if (line.length > 3 && line.startsWith('"""')) valQuote = '"""';
		else if (line[0] === "`") valQuote = "`";

		if (valQuote !== "") {
			const start = valQuote.length;
			const pos = line.lastIndexOf(valQuote);
			if (pos < start) {
				return this.readMultilines(line.slice(start), valQuote);
			}
			return { text: line.slice(start, pos), comment: "" };
		}

		line = line.trim();
		if (line === "") return { text: "", comment: "" };

		if (!this.options.ignoreContinuation && line.endsWith("\\")) {
			return { text: this.readContinuation(line.slice(0, -1)), comment: "" };
		}

		let comment = "";
		if (!this.options.ignoreInlineComment) {
			let i: number;
			if (this.options.spaceBeforeInlineComment) {
				i = line.indexOf(" #");
				if (i === -1) i = line.indexOf(" ;");
			} else {
				i = indexOfAny(line, "#;");
			}
			if (i > -1) {
				comment = line.slice(i);
				line = line.slice(0, i).trim();
			}
		}

		if (hasSurroundedQuote(line, "'") || hasSurroundedQuote(line, '"')) {
			line = line.slice(1, -1);
		}

		return { text: line, comment };
	}

	private readMultilines(
		start: string,
		valQuote: string,
	): { text: string; comment: string } {
		let val = start;
		for (;;) {
			const next = this.nextLine();
			if (next === null) {
				throw new Error(`missing closing key quote: ${start}`);
			}
			const pos = next.lastIndexOf(valQuote);
			if (pos > -1) {
				val += `\n${next.slice(0, pos)}`;
				const comment = cleanComment(next.slice(pos));
				return { text: val, comment: comment === null ? "" : comment.trim() };
			}
			val += `\n${next}`;
		}
	}

	private readContinuation(start: string): string {
		let val = start;
		for (;;) {
			const raw = this.nextLine();
			if (raw === null) return val;
			const next = raw.trim();
			if (next.length === 0) return val;
			val += next;
			if (!val.endsWith("\\")) return val;
			val = val.slice(0, -1);
		}
	}
}

/** Whether the value is wrapped in a matching pair of quotes and no others. */
function hasSurroundedQuote(s: string, quote: string): boolean {
	return (
		s.length >= 2 &&
		s[0] === quote &&
		s[s.length - 1] === quote &&
		s.indexOf(quote, 1) === s.length - 1
	);
}
