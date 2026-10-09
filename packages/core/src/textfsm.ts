/**
 * TextFSM: line-oriented text read through a template.
 *
 * A template is a state machine whose rules are regular expressions, in the
 * form Google's TextFSM defined for parsing the output of network devices. It
 * declares the values it captures, then the states it moves through. Each
 * state is a list of rules, tried in order against the current line; the first
 * to match assigns its captures and says what happens next: which line to read,
 * whether to emit a record, and which state to enter.
 *
 *	Value Subject (.+)
 *	Value List Body (.*)
 *
 *	Start
 *	  ^${Subject} -> Body
 *
 *	Body
 *	  ^${Body}
 *
 * The result is a list of records, one per `Record` action plus the one implied
 * at the end of input, each holding the captures that filled it -- with the
 * line and column each capture came from, which is what places an alert.
 */

import { strLen } from "./util.ts";
import type { ScopedValue } from "./view.ts";

/** One named capture a template fills. */
export interface Value {
	name: string;
	regex: string;
	/** Keeps the last capture across records. */
	filldown: boolean;
	/** Drops a record the value is missing from. */
	required: boolean;
	/** Gathers every capture rather than the last one. */
	list: boolean;
}

/**
 * One piece of text a value took, and where it came from.
 *
 * Line and column are 1-based, and the column counts characters.
 */
export interface Capture {
	text: string;
	line: number;
	column: number;
}

/**
 * One emitted set of captures, keyed by value name.
 *
 * A `List` value holds every capture; any other holds one.
 */
export type Record_ = Record<string, Capture[]>;

/** What a matching rule does once it has assigned its captures. */
type Disposition = "NoRecord" | "Record" | "Clear" | "Clearall" | "Error";

interface Rule {
	re: RegExp;
	/** The state to enter, or "" to stay. */
	next: string;
	/** `Continue`: keep trying the rules on this line. */
	cont: boolean;
	rec: Disposition;
	errMsg: string;
}

const VALUE_RE = /^Value\s+(?:((?:\w+,?)+)\s+)?(\w+)\s+\((.*)\)\s*$/;
const VAR_RE = /\$\{(\w+)\}|\$(\w+)/g;

/** A compiled state machine. */
export class Template {
	readonly values: Value[] = [];

	private readonly states = new Map<string, Rule[]>();
	private readonly names = new Map<string, Value>();

	/** Use `parseTemplate`. */
	private constructor() {}

	/**
	 * Compiles a template.
	 *
	 * Values come first, up to the blank line that ends them; states follow,
	 * each one a line at the left margin with its rules indented under it.
	 */
	static parse(src: string): Template {
		const t = new Template();
		const lines = src.replaceAll("\r\n", "\n").split("\n");
		let i = 0;

		for (; i < lines.length; i++) {
			const line = lines[i]!.trim();
			if (line === "") {
				if (t.values.length > 0) break;
				continue;
			}
			if (line.startsWith("#")) continue;

			const m = VALUE_RE.exec(line);
			if (m === null) {
				if (t.values.length === 0) {
					throw new Error(
						`line ${i + 1}: a template needs at least one Value before its states, got ${quote(line)}`,
					);
				}
				throw new Error(
					`line ${i + 1}: expected a Value definition, got ${quote(line)}`,
				);
			}

			const v: Value = {
				name: m[2]!,
				regex: m[3]!,
				filldown: false,
				required: false,
				list: false,
			};
			for (const opt of (m[1] ?? "").split(",")) {
				switch (opt.trim()) {
					case "":
						break;
					case "Filldown":
						v.filldown = true;
						break;
					case "Required":
						v.required = true;
						break;
					case "List":
						v.list = true;
						break;
					case "Key":
					case "Fillup":
						// Accepted for compatibility; neither changes what is
						// captured.
						break;
					default:
						throw new Error(`line ${i + 1}: unknown Value option ${quote(opt)}`);
				}
			}
			if (t.names.has(v.name)) {
				throw new Error(`line ${i + 1}: Value ${quote(v.name)} defined twice`);
			}
			t.values.push(v);
			t.names.set(v.name, v);
		}
		if (t.values.length === 0) {
			throw new Error("a template needs at least one Value");
		}

		let state = "";
		for (; i < lines.length; i++) {
			const raw = lines[i]!;
			const line = raw.trim();
			if (line === "" || line.startsWith("#")) continue;

			if (!raw.startsWith(" ") && !raw.startsWith("\t")) {
				if (t.states.has(line)) {
					throw new Error(`line ${i + 1}: state ${quote(line)} defined twice`);
				}
				state = line;
				t.states.set(state, []);
				continue;
			}
			if (state === "") {
				throw new Error(`line ${i + 1}: a rule before any state`);
			}
			try {
				t.states.get(state)!.push(t.parseRule(line));
			} catch (err) {
				throw new Error(
					`line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		if (!t.states.has("Start")) {
			throw new Error("a template needs a Start state");
		}
		for (const [name, rules] of t.states) {
			for (const r of rules) {
				if (
					r.next !== "" &&
					r.next !== "End" &&
					r.next !== "EOF" &&
					!t.states.has(r.next)
				) {
					throw new Error(
						`state ${quote(name)} moves to ${quote(r.next)}, which is not defined`,
					);
				}
			}
		}

		return t;
	}

	/** Reads `^pattern -> [Line.][Record] [State]`. */
	private parseRule(line: string): Rule {
		const r: Rule = {
			re: /(?:)/,
			next: "",
			cont: false,
			rec: "NoRecord",
			errMsg: "",
		};

		const cut = line.indexOf("->");
		const pattern = (cut < 0 ? line : line.slice(0, cut)).trim();
		const action = cut < 0 ? "" : line.slice(cut + 2);

		const expanded = this.expand(pattern);
		try {
			// The `d` flag is what gives a capture its position, and so a
			// capture its column.
			r.re = new RegExp(expanded, "d");
		} catch (err) {
			throw new Error(
				`invalid rule ${quote(pattern)}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (cut < 0) return r;

		for (const tok of action.split(/\s+/).filter((s) => s !== "")) {
			// An Error's message, quoted, may run to several words.
			if (tok.startsWith('"') || (r.rec === "Error" && r.errMsg !== "")) {
				r.errMsg = `${r.errMsg} ${trimQuotes(tok)}`.trim();
				continue;
			}
			for (const part of tok.split(".")) {
				switch (part) {
					case "Next":
						break;
					case "Continue":
						r.cont = true;
						break;
					case "Record":
					case "NoRecord":
					case "Clear":
					case "Clearall":
					case "Error":
						r.rec = part;
						break;
					default:
						if (r.next !== "") {
							throw new Error(
								`rule names two states, ${quote(r.next)} and ${quote(part)}`,
							);
						}
						r.next = part;
				}
			}
		}
		if (r.cont && r.next !== "") {
			throw new Error("a Continue rule cannot change state");
		}
		return r;
	}

	/**
	 * Turns each `${Name}` in a pattern into a named group holding that
	 * value's regex.
	 */
	private expand(pattern: string): string {
		let bad: Error | null = null;
		const out = pattern.replace(VAR_RE, (whole, braced, bare) => {
			const name = (braced as string | undefined) ?? (bare as string);
			const v = this.names.get(name);
			if (v === undefined) {
				bad = new Error(`rule references undefined Value ${quote(name)}`);
				return whole as string;
			}
			return `(?<${name}>${v.regex})`;
		});
		if (bad !== null) throw bad;
		return out;
	}

	/** Reads text through the template and returns its records. */
	run(text: string): Record_[] {
		const out: Record_[] = [];
		let cur: Record_ = {};
		let state = "Start";

		const emit = (): void => {
			if (Object.keys(cur).length === 0) return;
			for (const v of this.values) {
				if (v.required && (cur[v.name] ?? []).length === 0) return;
			}
			out.push(cur);
			cur = this.carry(cur);
		};

		const lines = text.replaceAll("\r\n", "\n").split("\n");
		for (let n = 0; n < lines.length; n++) {
			if (state === "End") break;
			const line = lines[n]!;

			for (const r of this.states.get(state) ?? []) {
				const m = r.re.exec(line);
				if (m === null) continue;
				this.assign(cur, m, n + 1, line);

				switch (r.rec) {
					case "Record":
						emit();
						break;
					case "Clear":
						cur = this.carry(cur);
						break;
					case "Clearall":
						cur = {};
						break;
					case "Error":
						throw new Error(`line ${n + 1}: ${r.errMsg}`);
					default:
						break;
				}
				if (r.next !== "") state = r.next;
				if (!r.cont) break;
			}
		}

		// An EOF state, if defined, replaces the record implied at end of
		// input: declaring an empty one drops it.
		const eof = this.states.get("EOF");
		if (eof !== undefined) {
			for (const r of eof) {
				if (r.rec === "Record") emit();
			}
			return out;
		}
		emit();
		return out;
	}

	/** Starts the next record with the `Filldown` values of the last. */
	private carry(prev: Record_): Record_ {
		const next: Record_ = {};
		for (const v of this.values) {
			const caps = prev[v.name];
			if (v.filldown && caps !== undefined && caps.length > 0) {
				next[v.name] = caps;
			}
		}
		return next;
	}

	/**
	 * Copies a match's named groups into the record.
	 *
	 * A group that matched the empty string still counts: a blank line in a
	 * body is a capture, and the paragraph break it marks has to survive.
	 */
	private assign(rec: Record_, m: RegExpExecArray, n: number, line: string): void {
		const groups = m.groups;
		if (groups === undefined) return;
		const spans = m.indices?.groups;

		for (const name of Object.keys(groups)) {
			const text = groups[name];
			if (text === undefined) continue;
			const v = this.names.get(name);
			if (v === undefined) continue;

			const at = spans?.[name]?.[0] ?? 0;
			const c: Capture = {
				text,
				line: n,
				column: strLen(line.slice(0, at)) + 1,
			};
			if (v.list) {
				const caps = rec[name];
				if (caps === undefined) rec[name] = [c];
				else caps.push(c);
			} else {
				rec[name] = [c];
			}
		}
	}
}

/** Compiles a template. */
export function parseTemplate(src: string): Template {
	return Template.parse(src);
}

/**
 * Joins a value's captures into the values a scope reports.
 *
 * Captures on consecutive lines belong to one value, so a body reads as the
 * paragraphs it is rather than one block per line. A gap in the lines starts
 * another value, and so does a change of column: a value is placed by one line
 * and one column, so every line in it has to start where its first line does.
 */
export function joinCaptures(caps: Capture[]): ScopedValue[] {
	const out: ScopedValue[] = [];
	let run: string[] | null = null;
	let start: Capture = { text: "", line: 0, column: 0 };

	const flush = (): void => {
		const text = (run ?? []).join("\n").replace(/\n+$/, "");
		if (text.trim() !== "") {
			out.push({ text, line: start.line, column: start.column });
		}
		run = null;
	};

	for (let i = 0; i < caps.length; i++) {
		const c = caps[i]!;
		const prev = caps[i - 1];
		if (
			prev !== undefined &&
			(c.line !== prev.line + 1 || c.column !== prev.column)
		) {
			flush();
		}
		if (run === null) {
			start = c;
			run = [];
		}
		run.push(c.text);
	}
	if (run !== null) flush();

	return out;
}

/** Go's `strings.Trim(s, "\"")`: the quotes around a word, not within it. */
function trimQuotes(s: string): string {
	return s.replace(/^"+/, "").replace(/"+$/, "");
}

/** Go's `%q`, as far as these messages need it. */
function quote(s: string): string {
	return JSON.stringify(s);
}
