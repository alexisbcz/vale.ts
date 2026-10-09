/**
 * The Tengo interpreter, reached lazily.
 *
 * Three things here run Tengo: a `script` rule, a `metric` formula and a
 * `suggest` action. None of them is on the path of an ordinary rule, and the
 * interpreter is a package of its own, so it is loaded on first use rather
 * than on import -- which also keeps a configuration that uses none of them
 * from paying to parse it.
 *
 * The contract is declared here rather than imported as types so that this
 * package type-checks against the interface it was written to, and a change on
 * the other side shows up as a mismatch at the one call site that adapts it.
 */

import { createRequire } from "node:module";

/** A compiled program with its own copy of the globals. */
export interface Compiled {
	set(name: string, value: unknown): void;
	run(options?: { timeoutMs?: number }): void;
	get(name: string): unknown;
}

/** A parsed program, shared between the clones that run it. */
export interface CompiledScript {
	add(name: string, value: unknown): void;
	clone(): Compiled;
}

export interface TengoModule {
	Script: {
		compile(
			source: string,
			options?: { modules?: readonly string[] },
		): CompiledScript;
	};
	TengoError: new (message?: string) => Error;
	TengoTimeout: new (message?: string) => Error;
	describeSource(source: string): {
		statements: number;
		firstIsExpression: boolean;
	};
}

let loaded: TengoModule | null = null;

/** The interpreter, loaded once. */
export function tengo(): TengoModule {
	if (loaded === null) {
		const req = createRequire(import.meta.url);
		loaded = req("@vale-ts/tengo") as TengoModule;
	}
	return loaded;
}

/** Whether `err` is the interpreter's deadline. */
export function isTimeout(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === "TengoTimeout") return true;
	try {
		return err instanceof tengo().TengoTimeout;
	} catch {
		return false;
	}
}
