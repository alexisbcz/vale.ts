/**
 * The version this build reports.
 *
 * Go sets it at link time and leaves `master` in the source, which makes every
 * package's `vale_version` floor pass on a development build. Here it is the
 * release this port reproduces, so that a package's floor is checked against
 * the same number the reference binary checks it against -- and a test can
 * stand it in for another.
 */

const DEFAULT_VERSION = "3.24.0";

let current = DEFAULT_VERSION;

/** The version `vale --version` prints and `sync` compares against. */
export function version(): string {
	return current;
}

/** Stands a different version in, and returns the one that was there. */
export function setVersion(next: string): string {
	const was = current;
	current = next;
	return was;
}
