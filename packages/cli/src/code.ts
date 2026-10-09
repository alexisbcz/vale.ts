/**
 * Loading the code-comment grammars, which is the one asynchronous step a run
 * has.
 *
 * `@vale-ts/lint` reads tree-sitter grammars from WebAssembly, and that has to
 * be awaited. It is reached through a dynamic import so that the CLI does not
 * stop working while the function is still being added to that package, and
 * because a run that never lints a source file never pays for it.
 */

/** Prepares the code readers, if this build of the linter has them. */
export async function initCode(): Promise<void> {
	const lint = (await import("@vale-ts/lint")) as {
		initCode?: () => Promise<void> | void;
	};
	await lint.initCode?.();
}
