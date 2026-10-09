/**
 * Preparing a document for rules scoped with `doc(...)`.
 *
 * The walker reads a token stream and never holds the tree a CSS selector
 * needs, so the tree is built here, ahead of it: each heading is wrapped with
 * what follows it into a `section`, every element a selector matches is marked
 * with that selector's id, and the result is rendered back to the stream the
 * walker reads. The mark then reaches each block inside the element as an
 * `in.<id>` part of its scope, which is what the selector's rule matches on.
 *
 * This runs only when some rule declares a selector or asks for quotations, so
 * a style with neither reads the document exactly as before.
 */

import { closingQuote, openingQuote } from "@vale-ts/nlp";
import { selectAll } from "css-select";
import type { AnyNode, Element } from "domhandler";
import { Element as DomElement, Text as DomText } from "domhandler";
import { hasChildren, removeElement } from "domutils";
import { parse as parseHTML, serializeOuter } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";
import { MARK_ATTR } from "./ast.ts";

/** The elements whose text is never a quotation. */
const QUOTE_SKIP = new Set([
	"head",
	"pre",
	"code",
	"tt",
	"kbd",
	"samp",
	"script",
	"style",
	"textarea",
	"q",
]);

/**
 * Rewrites `raw` so the walker can see what the selectors matched.
 *
 * With `quotes`, each quotation is wrapped in a `q` as well, so that a rule
 * scoped to `quote` finds it and one scoped to `~quote` leaves it out.
 */
export function markSelections(
	raw: string,
	sels: ReadonlyArray<{ id: string; sel: string }>,
	quotes: boolean,
): string {
	const doc = parseHTML(raw, { treeAdapter: adapter }) as unknown as AnyNode;

	wrapSections(doc);
	if (quotes) wrapQuotes(doc);

	for (const s of sels) {
		let matched: Element[];
		try {
			matched = selectAll(s.sel, doc as never) as Element[];
		} catch {
			// A selector the engine cannot read marks nothing, so the rule that
			// declared it reports its element as absent -- which is the honest
			// answer, and better than failing the run.
			continue;
		}
		for (const n of matched) mark(n, s.id);
	}

	return serialize(doc);
}

/**
 * Encloses each heading and the siblings that follow it, up to the next heading
 * of the same or a higher level, in a `section` element.
 *
 * Sections nest: an `h3` after an `h2` sits inside the `h2`'s section. The
 * wrapping is done among siblings, so a heading inside a list item or a
 * blockquote sections its neighbors there and nothing outside.
 */
export function wrapSections(n: AnyNode): void {
	if (!hasChildren(n)) return;

	for (const c of [...n.children]) {
		if (isElement(c)) wrapSections(c);
	}

	const open: Element[] = [];
	const levels: number[] = [];

	for (const c of [...n.children]) {
		const level = headingLevel(c);
		if (level > 0) {
			while (levels.length > 0 && levels[levels.length - 1]! >= level) {
				open.pop();
				levels.pop();
			}

			const sec = new DomElement("section", {});
			const parent = open[open.length - 1];
			if (parent !== undefined) appendChild(parent, sec);
			else insertBefore(n, sec, c);

			detach(c);
			appendChild(sec, c);

			open.push(sec);
			levels.push(level);
		} else if (open.length > 0) {
			detach(c);
			appendChild(open[open.length - 1]!, c);
		}
	}
}

/**
 * Encloses each quotation under `n` in a `q` element.
 *
 * Pairing is done among an element's own text nodes, so a quotation may hold
 * inline markup -- "we *knew*" -- and one that opens in a text node and never
 * closes runs to the end of the element. An element that already is a
 * quotation, or holds code, is left alone.
 */
export function wrapQuotes(n: AnyNode): void {
	if (!hasChildren(n)) return;

	for (const c of [...n.children]) {
		if (isElement(c) && !QUOTE_SKIP.has(c.name)) wrapQuotes(c);
	}

	let c: AnyNode | null = n.children[0] ?? null;
	while (c !== null) {
		if (!isText(c)) {
			c = c.next;
			continue;
		}

		const opened = openingQuote(c.data, 0);
		if (opened.at < 0) {
			c = c.next;
			continue;
		}

		// The text before the mark stays where it is.
		let rest: AnyNode = c;
		if (opened.at > 0) {
			rest = new DomText(c.data.slice(opened.at));
			c.data = c.data.slice(0, opened.at);
			insertAfter(n, rest, c);
		}

		const q = new DomElement("q", {});
		insertBefore(n, q, rest);

		// Move nodes into the quotation until a text node closes it.
		let after: AnyNode | null = null;
		let from = opened.size;
		let m: AnyNode | null = rest;
		while (m !== null) {
			const next: AnyNode | null = m.next;
			if (isText(m)) {
				const end = closingQuote(m.data, opened.closer, from);
				if (end >= 0) {
					if (end < m.data.length) {
						after = new DomText(m.data.slice(end));
						m.data = m.data.slice(0, end);
						insertAfter(n, after, m);
					} else {
						after = next;
					}
					detach(m);
					appendChild(q, m);
					break;
				}
			}
			detach(m);
			appendChild(q, m);
			m = next;
			from = 0;
		}

		c = after;
	}
}

/** 1 through 6 for a heading element, and 0 otherwise. */
function headingLevel(n: AnyNode): number {
	if (!isElement(n) || n.name.length !== 2 || n.name[0] !== "h") return 0;
	const level = n.name.charCodeAt(1) - 0x30;
	return level >= 1 && level <= 6 ? level : 0;
}

function mark(n: Element, id: string): void {
	const existing = n.attribs[MARK_ATTR];
	n.attribs[MARK_ATTR] = existing === undefined ? id : `${existing} ${id}`;
}

function isElement(n: AnyNode): n is Element {
	return n.type === "tag" || n.type === "script" || n.type === "style";
}

function isText(n: AnyNode): n is DomText {
	return n.type === "text";
}

function appendChild(parent: AnyNode, child: AnyNode): void {
	if (!hasChildren(parent)) return;
	const prev = parent.children[parent.children.length - 1];
	parent.children.push(child);
	child.parent = parent;
	child.prev = prev ?? null;
	child.next = null;
	if (prev !== undefined) prev.next = child;
}

function insertBefore(parent: AnyNode, node: AnyNode, ref: AnyNode): void {
	if (!hasChildren(parent)) return;
	const at = parent.children.indexOf(ref);
	if (at < 0) {
		appendChild(parent, node);
		return;
	}
	parent.children.splice(at, 0, node);
	node.parent = parent;
	node.prev = ref.prev;
	node.next = ref;
	if (ref.prev !== null) ref.prev.next = node;
	ref.prev = node;
}

function insertAfter(parent: AnyNode, node: AnyNode, ref: AnyNode): void {
	if (!hasChildren(parent)) return;
	const at = parent.children.indexOf(ref);
	if (at < 0) {
		appendChild(parent, node);
		return;
	}
	parent.children.splice(at + 1, 0, node);
	node.parent = parent;
	node.prev = ref;
	node.next = ref.next;
	if (ref.next !== null) ref.next.prev = node;
	ref.next = node;
}

function detach(node: AnyNode): void {
	removeElement(node);
	node.parent = null;
	node.prev = null;
	node.next = null;
}

/** Renders the tree back to HTML. */
function serialize(doc: AnyNode): string {
	if (!hasChildren(doc)) return "";
	let out = "";
	for (const c of doc.children) {
		out += serializeOuter(c as never, { treeAdapter: adapter });
	}
	return out;
}
