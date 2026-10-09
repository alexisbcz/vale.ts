/**
 * How far a comment's text sits from the margin of the line it was written on.
 *
 * An alert is reported against the extracted comment, where the delimiters are
 * gone; putting it back in the source means adding what came off. This is the
 * part that is measured from the source line rather than recorded during
 * extraction -- see `Comment.strip` for the other half.
 */

import { strLen } from "@vale-ts/core";

/**
 * The ` *` that decorates each line of a JSDoc, Javadoc or Doxygen block.
 *
 * The `*` only counts as decoration when whitespace or the end of the line
 * follows it. `*emphasis*` and `*item` are content, and a pattern that took
 * them for decoration would quietly delete the markup it was meant to expose.
 */
export const C_STYLE_PREFIX = /^([ \t]*\*)(?:[ \t]|$)/;

/**
 * How much of `s` is comment marker and the spaces after it.
 *
 * Markers repeat -- a `##` banner, Julia's `#=` opener against a plain `#` --
 * so the longest is consumed at each step until prose begins. This has to
 * mirror what `stripDelims` took off, or an alert lands short.
 */
export function computePadding(s: string, markers: readonly string[]): number {
	let padding = 0;
	let rest = s;

	for (;;) {
		let matched = "";
		for (const m of markers) {
			if (rest.startsWith(m) && m.length > matched.length) matched = m;
		}
		if (matched === "") break;
		padding += strLen(matched);
		rest = rest.slice(matched.length);
	}

	if (padding === 0) return 0;
	for (const r of rest) {
		if (r !== " ") break;
		padding++;
	}

	return padding;
}

/** `computePadding` for the C family. */
export function cStyle(s: string): number {
	return computePadding(s, ["/*", "//"]);
}
