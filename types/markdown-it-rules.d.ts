/**
 * The one markdown-it rule this package reaches into.
 *
 * `mdx.ts` replaces the HTML block rule with a wrapper that declines a single
 * line holding a JSX element with text between its tags, and delegates every
 * other line to the original. `@types/markdown-it` describes the package's
 * entry point but not its rule modules, so the signature is written here.
 */
declare module "markdown-it/lib/rules_block/html_block.mjs" {
	import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";

	const htmlBlock: (
		state: StateBlock,
		startLine: number,
		endLine: number,
		silent: boolean,
	) => boolean;
	export default htmlBlock;
}
