/**
 * Prints a parsed pattern back out as one `RegExp` accepts.
 *
 * Two rewrites carry most of the weight. A bare `(?i)` changes the flags for
 * the rest of the group it sits in, which JavaScript has no way to say, so the
 * rest of that group is wrapped in a `(?i:...)` modifier group instead. And
 * every capturing group is given a synthetic name, because .NET numbers its
 * unnamed groups before its named ones while JavaScript numbers them in source
 * order -- naming them means a rule that reads group 3 still reads group 3.
 */

import type {
	CharClass,
	ClassItem,
	FlagSet,
	Group,
	Node,
	Sequence,
} from "./ast.ts";
import { PatternError } from "./parse.ts";
import {
	NON_WORD_BOUNDARY,
	POSIX_CLASSES,
	RE2_SPACE,
	translateProperty,
	WORD_BOUNDARY,
} from "./unicode.ts";

export interface RenderOptions {
	/** The pattern as written, for error messages. */
	source: string;
	/**
	 * Use JavaScript's ASCII `\b` instead of .NET's Unicode-aware one.
	 *
	 * The faithful form is a pair of lookarounds, which is slower. Rules that
	 * only ever see ASCII get the same answer either way.
	 */
	asciiWordBoundary?: boolean;
}

export interface RenderResult {
	/** The pattern body. */
	source: string;
	/** Flags hoisted out of leading inline directives. */
	flags: FlagSet;
	/** Whether the result needs the `v` flag rather than `u`. */
	needsSetOps: boolean;
}

/** The characters `\` may precede outside a character class in `u` mode. */
const SYNTAX_CHARS = new Set([
	"^",
	"$",
	"\\",
	".",
	"*",
	"+",
	"?",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	"|",
	"/",
]);

export function render(root: Node, opts: RenderOptions): RenderResult {
	const r = new Renderer(opts);
	// A directive at the very start of the pattern is the common case -- a rule
	// written `(?i)(?m)\b(?:...)\b` -- and hoisting it to a real flag is both
	// clearer and faster than wrapping the entire body in a modifier group.
	const { node, flags } = hoistLeadingFlags(root);
	const scoped = normalize(node).node;
	return { source: r.node(scoped, 0), flags, needsSetOps: r.needsSetOps };
}

/**
 * Rewrites every bare `(?i)` as the scoped group it is equivalent to, so that
 * the renderer never has to reason about a directive's reach.
 *
 * A directive holds until the end of the group it sits in. Within a sequence
 * that is everything after it; across an alternation it is also every later
 * branch, because an alternation is not itself a group. The earlier branches,
 * and the part of its own branch that precedes it, are untouched.
 *
 * Returns the rewritten node along with the flags it declared, which the
 * caller propagates to whatever follows at the same level.
 */
function normalize(n: Node): { node: Node; set: FlagSet; clear: FlagSet } {
	const none = { set: {} as FlagSet, clear: {} as FlagSet };

	switch (n.kind) {
		case "inline-flags":
			// Nothing follows it in its group, so it has nothing to apply to.
			return { node: { kind: "empty" }, set: n.set, clear: n.clear };

		case "seq": {
			const at = n.terms.findIndex((t) => t.kind === "inline-flags");
			if (at < 0) {
				return {
					node: { kind: "seq", terms: n.terms.map((t) => normalize(t).node) },
					...none,
				};
			}
			const directive = n.terms[at] as Extract<Node, { kind: "inline-flags" }>;
			const head = n.terms.slice(0, at).map((t) => normalize(t).node);
			const tail = normalize({ kind: "seq", terms: n.terms.slice(at + 1) });
			const wrapped: Node = {
				kind: "group",
				type: "scoped-flags",
				set: directive.set,
				clear: directive.clear,
				body: tail.node,
			};
			// What the sequence as a whole declares: this directive, then
			// whatever the rest of it went on to say.
			const net = merge(
				merge({}, directive.set, directive.clear),
				tail.set,
				tail.clear,
			);
			return {
				node: { kind: "seq", terms: [...head, wrapped] },
				set: onOf(net),
				clear: offOf(net),
			};
		}

		case "alt": {
			// `pending` is tri-state per flag: absent means inherited, true on,
			// false off. It accumulates across branches because a directive in
			// one covers every branch after it.
			let pending: TriFlags = {};
			const branches: Sequence[] = [];

			for (const branch of n.branches) {
				const done = normalize(branch);
				let node = done.node;
				if (hasAny(pending)) {
					node = {
						kind: "group",
						type: "scoped-flags",
						set: onOf(pending),
						clear: offOf(pending),
						body: node,
					};
				}
				branches.push(node.kind === "seq" ? node : { kind: "seq", terms: [node] });
				pending = merge(pending, done.set, done.clear);
			}

			return {
				node: { kind: "alt", branches },
				set: onOf(pending),
				clear: offOf(pending),
			};
		}

		case "quant":
			return { node: { ...n, atom: normalize(n.atom).node }, ...none };

		case "group":
			// A group bounds a directive's reach, so nothing escapes from here.
			return { node: { ...n, body: normalize(n.body).node }, ...none };

		default:
			return { node: n, ...none };
	}
}

/** A flag's three states: on, off, or inherited from the enclosing scope. */
type TriFlags = { i?: boolean; m?: boolean; s?: boolean };

const TRACKED = ["i", "m", "s"] as const;

function hasAny(f: TriFlags): boolean {
	return TRACKED.some((k) => f[k] !== undefined);
}

function merge(base: TriFlags, set: FlagSet, clear: FlagSet): TriFlags {
	const out: TriFlags = { ...base };
	for (const k of TRACKED) {
		if (set[k]) out[k] = true;
		else if (clear[k]) out[k] = false;
	}
	return out;
}

function onOf(f: TriFlags): FlagSet {
	const out: FlagSet = {};
	for (const k of TRACKED) if (f[k] === true) out[k] = true;
	return out;
}

function offOf(f: TriFlags): FlagSet {
	const out: FlagSet = {};
	for (const k of TRACKED) if (f[k] === false) out[k] = true;
	return out;
}

/**
 * Peels the inline directives off the front of the pattern.
 *
 * Only directives that apply to everything can be hoisted: the first term of
 * the top-level sequence, and then the next, for as long as they are
 * directives. Anything further in changes the flags partway through and has to
 * stay where it is.
 */
function hoistLeadingFlags(root: Node): { node: Node; flags: FlagSet } {
	const flags: FlagSet = {};
	if (root.kind === "inline-flags") {
		assign(flags, root.set, root.clear);
		return { node: { kind: "empty" }, flags };
	}
	if (root.kind === "alt") {
		// `(?i)a|b` -- nothing precedes the directive, so its reach is the whole
		// pattern and it can become a real flag.
		const branches = root.branches.slice();
		const first = branches[0];
		while (first && first.terms[0]?.kind === "inline-flags") {
			const term = first.terms.shift() as Extract<Node, { kind: "inline-flags" }>;
			assign(flags, term.set, term.clear);
		}
		return { node: { kind: "alt", branches }, flags };
	}

	if (root.kind !== "seq") return { node: root, flags };

	let i = 0;
	while (i < root.terms.length && root.terms[i]!.kind === "inline-flags") {
		const term = root.terms[i] as Extract<Node, { kind: "inline-flags" }>;
		assign(flags, term.set, term.clear);
		i++;
	}
	if (i === 0) return { node: root, flags };

	const rest = root.terms.slice(i);
	const node: Node =
		rest.length === 0
			? { kind: "empty" }
			: rest.length === 1
				? rest[0]!
				: { kind: "seq", terms: rest };
	return { node, flags };
}

function assign(into: FlagSet, set: FlagSet, clear: FlagSet): void {
	for (const k of ["i", "m", "s"] as const) {
		if (set[k]) into[k] = true;
		if (clear[k]) into[k] = false;
	}
}

class Renderer {
	needsSetOps = false;
	private readonly opts: RenderOptions;

	constructor(opts: RenderOptions) {
		this.opts = opts;
	}

	node(n: Node, depth: number): string {
		switch (n.kind) {
			case "empty":
				return "";
			case "lit":
				return escapeLiteral(n.value);
			case "dot":
				return ".";
			case "anchor":
				return this.anchor(n.type);
			case "class":
				return this.charClass(n);
			case "backref":
				return typeof n.ref === "number"
					? `\\k<${syntheticName(n.ref)}>`
					: `\\k<${namedRef(n.ref)}>`;
			case "quant":
				return this.quantified(n, depth);
			case "group":
				return this.group(n, depth);
			case "seq":
				return this.sequence(n, depth);
			case "alt":
				return this.alternation(n.branches, depth);
			case "inline-flags":
				// A directive reached here is one no enclosing sequence wrapped,
				// which means it is the only thing in its group: nothing follows
				// for it to apply to.
				return "";
		}
	}

	/**
	 * Renders a sequence, turning a directive into a group around what follows.
	 *
	 * `a(?i)bc` is `a(?i:bc)`.
	 */
	private sequence(s: Sequence, depth: number): string {
		let out = "";
		for (let i = 0; i < s.terms.length; i++) {
			const term = s.terms[i]!;
			if (term.kind !== "inline-flags") {
				out += this.node(term, depth);
				continue;
			}
			const rest = s.terms.slice(i + 1);
			const body =
				rest.length === 0 ? "" : this.sequence({ kind: "seq", terms: rest }, depth);
			const spec = flagSpec(term.set, term.clear);
			return spec === "" ? out + body : `${out}(?${spec}:${body})`;
		}
		return out;
	}

	/**
	 * Renders an alternation.
	 *
	 * `normalize` has already turned every directive into the scoped group it
	 * is equivalent to, so each branch stands on its own here.
	 */
	private alternation(branches: Sequence[], depth: number): string {
		return branches.map((b) => this.sequence(b, depth)).join("|");
	}

	private anchor(type: string): string {
		switch (type) {
			case "bol":
				return "^";
			case "eol":
				return "$";
			case "begin":
				// `\A` is the start of the input whether or not `m` is set, which
				// a bare `^` would not be.
				return "(?<![\\s\\S])";
			case "end":
				return "(?![\\s\\S])";
			case "endz":
				// `\Z`: the end, or just before a final newline.
				return "(?=\\n?(?![\\s\\S]))";
			case "start":
				throw new PatternError("`\\G` is not supported", this.opts.source, 0);
			case "word":
				return this.opts.asciiWordBoundary ? "\\b" : WORD_BOUNDARY;
			case "nonword":
				return this.opts.asciiWordBoundary ? "\\B" : NON_WORD_BOUNDARY;
			default:
				throw new PatternError(`unknown anchor \`${type}\``, this.opts.source, 0);
		}
	}

	private quantified(n: Extract<Node, { kind: "quant" }>, depth: number): string {
		const atom = this.atomFor(n.atom, depth);
		let rep: string;
		if (n.min === 0 && n.max === Infinity) rep = "*";
		else if (n.min === 1 && n.max === Infinity) rep = "+";
		else if (n.min === 0 && n.max === 1) rep = "?";
		else if (n.max === Infinity) rep = `{${n.min},}`;
		else if (n.min === n.max) rep = `{${n.min}}`;
		else rep = `{${n.min},${n.max}}`;

		if (n.lazy) rep += "?";
		if (n.possessive) {
			// A possessive quantifier is an atomic group around a greedy one.
			return this.atomicWrap(`${atom}${rep}`, depth);
		}
		return atom + rep;
	}

	/**
	 * Renders a node in a position where a quantifier will follow, adding the
	 * grouping a bare sequence or alternation needs for the quantifier to apply
	 * to all of it.
	 */
	private atomFor(n: Node, depth: number): string {
		const out = this.node(n, depth);
		switch (n.kind) {
			case "lit":
				return [...n.value].length > 1 ? `(?:${out})` : out;
			case "seq":
			case "alt":
				return `(?:${out})`;
			case "anchor":
				// `\b*` is legal and matches empty; the lookaround form needs a
				// group for the quantifier to bind to the whole thing.
				return out.startsWith("(") ? out : `(?:${out})`;
			default:
				return out;
		}
	}

	private group(g: Group, depth: number): string {
		const body = this.node(g.body, depth + 1);
		switch (g.type) {
			case "capture":
			case "named":
				// Named rather than numbered: see the file comment.
				return `(?<${syntheticName(g.number ?? 0)}>${body})`;
			case "noncapture":
				return `(?:${body})`;
			case "lookahead":
				return `(?=${body})`;
			case "neg-lookahead":
				return `(?!${body})`;
			case "lookbehind":
				return `(?<=${body})`;
			case "neg-lookbehind":
				return `(?<!${body})`;
			case "scoped-flags": {
				const spec = flagSpec(g.set ?? {}, g.clear ?? {});
				return spec === "" ? `(?:${body})` : `(?${spec}:${body})`;
			}
			case "atomic":
				return this.atomicWrap(body, depth);
			default:
				throw new PatternError(
					`unsupported group \`${g.type}\``,
					this.opts.source,
					0,
				);
		}
	}

	/**
	 * Emulates an atomic group, which JavaScript has no syntax for.
	 *
	 * `(?=(body))\k<name>` matches the same text and then consumes it through a
	 * backreference, which cannot be re-tried: once the lookahead has settled
	 * on a match, the backreference either fits or the whole thing fails.
	 */
	private atomicWrap(body: string, depth: number): string {
		const name = `va${depth}_${this.atomicCount++}`;
		return `(?=(?<${name}>${body}))\\k<${name}>`;
	}

	private atomicCount = 0;

	private charClass(c: CharClass): string {
		// A shorthand on its own is printed as itself rather than wrapped in
		// brackets, which keeps the output readable and avoids `v`-mode's rules
		// about nesting.
		if (!c.negated && !c.subtract && c.items.length === 1) {
			const only = c.items[0]!;
			const bare = this.bareItem(only);
			if (bare !== null) return bare;
		}

		const body = c.items.map((i) => this.classItem(i)).join("");
		const head = `[${c.negated ? "^" : ""}${body}]`;
		if (!c.subtract) return head;

		this.needsSetOps = true;
		const minus = this.charClass(c.subtract);
		return `[${head}--${minus}]`;
	}

	/** The standalone spelling of a one-item class, or null if it has none. */
	private bareItem(item: ClassItem): string | null {
		if (item.type === "shorthand") {
			switch (item.name) {
				case "d":
				case "D":
				case "w":
				case "W":
					return `\\${item.name}`;
				case "s":
					return `[${RE2_SPACE}]`;
				case "S":
					return `[^${RE2_SPACE}]`;
				default:
					return null;
			}
		}
		if (item.type === "property") {
			const mapped = this.property(item.name);
			return `\\${item.negated ? "P" : "p"}{${mapped}}`;
		}
		return null;
	}

	private classItem(item: ClassItem): string {
		switch (item.type) {
			case "char":
				return escapeInClass(item.value);
			case "range":
				return `${escapeInClass(item.from)}-${escapeInClass(item.to)}`;
			case "shorthand":
				switch (item.name) {
					case "d":
					case "D":
					case "w":
					case "W":
						return `\\${item.name}`;
					case "s":
						return RE2_SPACE;
					case "S":
						// A negated set inside a class needs set syntax, which is
						// what the `v` flag is for.
						this.needsSetOps = true;
						return `[^${RE2_SPACE}]`;
					default:
						return "";
				}
			case "property": {
				const mapped = this.property(item.name);
				return `\\${item.negated ? "P" : "p"}{${mapped}}`;
			}
			case "posix": {
				const ranges = POSIX_CLASSES[item.name.toLowerCase()];
				if (ranges === undefined) {
					throw new PatternError(
						`unknown POSIX class \`${item.name}\``,
						this.opts.source,
						0,
					);
				}
				if (!item.negated) return ranges;
				this.needsSetOps = true;
				return `[^${ranges}]`;
			}
			case "nested":
				this.needsSetOps = true;
				return this.charClass(item.value);
		}
	}

	private property(name: string): string {
		const mapped = translateProperty(name);
		if (mapped === null) {
			throw new PatternError(
				`unknown Unicode class \`${name}\``,
				this.opts.source,
				0,
			);
		}
		return mapped;
	}
}

/** The synthetic name standing for .NET capture group `n`. */
export function syntheticName(n: number): string {
	return `vg${n}`;
}

/**
 * The synthetic name a `\k<name>` backreference resolves to.
 *
 * Filled in by the translator, which knows the number each name was given.
 */
let nameToNumber = new Map<string, number>();

export function withNameMap<T>(map: Map<string, number>, fn: () => T): T {
	const prev = nameToNumber;
	nameToNumber = map;
	try {
		return fn();
	} finally {
		nameToNumber = prev;
	}
}

function namedRef(name: string): string {
	const n = nameToNumber.get(name);
	if (n === undefined) {
		// An unresolvable reference is a pattern error, but the message is
		// clearer coming from `RegExp` than from here.
		return `vgunknown_${name.replace(/[^A-Za-z0-9_]/g, "")}`;
	}
	return syntheticName(n);
}

function flagSpec(set: FlagSet, clear: FlagSet): string {
	let on = "";
	let off = "";
	for (const k of ["i", "m", "s"] as const) {
		if (set[k]) on += k;
		if (clear[k]) off += k;
	}
	if (on === "" && off === "") return "";
	return off === "" ? on : `${on}-${off}`;
}

/** Escapes a run of literal text for use outside a character class. */
export function escapeLiteral(value: string): string {
	let out = "";
	for (const ch of value) {
		if (SYNTAX_CHARS.has(ch)) {
			out += `\\${ch}`;
		} else if (ch === "\n") {
			out += "\\n";
		} else if (ch === "\r") {
			out += "\\r";
		} else if (ch === "\t") {
			out += "\\t";
		} else if (ch < " " || ch === "\u007f") {
			out += codeEscape(ch.codePointAt(0)!);
		} else {
			out += ch;
		}
	}
	return out;
}

/**
 * Escapes one code point for use inside a character class.
 *
 * Everything that isn't a letter or a digit becomes a numeric escape. The two
 * class syntaxes disagree about which characters need escaping -- `v` mode
 * reserves several that `u` mode does not, and forbids doubled punctuation --
 * so sidestepping the question entirely is both shorter and safer than
 * tracking which mode the output will be compiled in.
 */
function escapeInClass(cp: number): string {
	if (
		(cp >= 0x30 && cp <= 0x39) ||
		(cp >= 0x41 && cp <= 0x5a) ||
		(cp >= 0x61 && cp <= 0x7a)
	) {
		return String.fromCodePoint(cp);
	}
	return codeEscape(cp);
}

function codeEscape(cp: number): string {
	if (cp <= 0xff) return `\\x${cp.toString(16).padStart(2, "0")}`;
	if (cp <= 0xffff) return `\\u${cp.toString(16).padStart(4, "0")}`;
	return `\\u{${cp.toString(16)}}`;
}
