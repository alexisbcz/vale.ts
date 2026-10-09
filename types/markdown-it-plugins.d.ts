/**
 * Declarations for the two `markdown-it` plugins that ship without types.
 *
 * Both are small and stable, and `@types/` packages for them do not exist.
 * Declaring the shape used here is more honest than casting at the call site.
 */

declare module "markdown-it-footnote" {
	import type MarkdownIt from "markdown-it";
	const plugin: (md: MarkdownIt) => void;
	export default plugin;
}

declare module "markdown-it-task-lists" {
	import type MarkdownIt from "markdown-it";
	const plugin: (
		md: MarkdownIt,
		options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean },
	) => void;
	export default plugin;
}
