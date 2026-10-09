/**
 * Whether the Tengo interpreter is available.
 *
 * `@vale-ts/tengo` is written separately; until it lands, the tests that need
 * it are skipped rather than failing, so that this package's own behavior is
 * still covered.
 */

import { createRequire } from "node:module";

export function tengoAvailable(): boolean {
	try {
		createRequire(import.meta.url)("@vale-ts/tengo");
		return true;
	} catch {
		return false;
	}
}
