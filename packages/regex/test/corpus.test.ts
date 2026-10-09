/**
 * Every pattern in Vale's own test styles, compiled.
 *
 * The unit tests above check the constructs one at a time; this checks the
 * translator against what rules are actually written like. A pattern that does
 * not compile is a rule that cannot run, which is the worst failure this
 * package has -- worse than matching slightly differently, because the user
 * sees an error where they expected a lint.
 *
 * The corpus is fetched on demand by `bun run compat:fetch`, so this skips
 * itself on a fresh checkout rather than failing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { parse as parseYAML } from "yaml";
import { Regexp } from "../src/index.ts";

const STYLES = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"..",
	"..",
	"..",
	"tests",
	"compat",
	".cache",
	"testdata",
	"styles",
);

/** The keys of a rule definition that hold patterns. */
const PATTERN_KEYS = [
	"tokens",
	"raw",
	"exceptions",
	"ignore",
	"token",
	"first",
	"second",
	"pattern",
];

/** Every string nested anywhere under `v`. */
function strings(v: unknown, into: string[]): void {
	if (typeof v === "string") into.push(v);
	else if (Array.isArray(v)) for (const i of v) strings(i, into);
	else if (v !== null && typeof v === "object") {
		for (const i of Object.values(v)) strings(i, into);
	}
}

function yamlFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (at: string): void => {
		for (const name of readdirSync(at)) {
			const full = path.join(at, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (name.endsWith(".yml") || name.endsWith(".yaml")) out.push(full);
		}
	};
	walk(dir);
	return out;
}

/** Each pattern in the corpus, with the file it came from. */
function corpus(): Array<{ file: string; pattern: string }> {
	const out: Array<{ file: string; pattern: string }> = [];

	for (const file of yamlFiles(STYLES)) {
		let doc: Record<string, unknown>;
		try {
			doc = parseYAML(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			// A file that is not a rule -- a vocabulary, a view -- or one whose
			// YAML is deliberately broken for a test.
			continue;
		}
		if (doc === null || typeof doc !== "object") continue;

		const found: string[] = [];
		for (const key of PATTERN_KEYS) strings(doc[key], found);

		const swap = doc.swap;
		if (swap !== null && typeof swap === "object" && !Array.isArray(swap)) {
			found.push(...Object.keys(swap));
		}

		for (const pattern of found) out.push({ file, pattern });
	}

	return out;
}

const present = existsSync(STYLES);

describe.skipIf(!present)("the style corpus", () => {
	test("every pattern compiles", () => {
		const all = corpus();

		// A corpus this small would mean the fetch produced something
		// unexpected, and a passing test over nothing is worse than no test.
		expect(all.length).toBeGreaterThan(1000);

		const failed: string[] = [];
		for (const { file, pattern } of all) {
			try {
				Regexp.compile(pattern);
			} catch (err) {
				failed.push(
					`${path.relative(STYLES, file)}: ${pattern}\n    ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		expect(failed).toEqual([]);
	});

	test("a compiled pattern can be run without throwing", () => {
		// Translation and compilation are separate failures: a pattern that
		// `RegExp` accepted can still trip over something at match time.
		const subject =
			"The quick brown fox jumps over the lazy dog, and then utilizes it. " +
			"Node.js 1.0 — café, naïve; e.g. 100% of `code` $x = 1$ done.";

		const failed: string[] = [];
		for (const { file, pattern } of corpus()) {
			try {
				Regexp.compile(pattern).findAllStringIndex(subject, 20);
			} catch (err) {
				failed.push(
					`${path.relative(STYLES, file)}: ${pattern}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		expect(failed).toEqual([]);
	});
});
