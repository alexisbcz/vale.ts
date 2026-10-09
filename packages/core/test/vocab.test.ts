/**
 * A YAML vocabulary: the terms a project accepts and the terms it rejects.
 *
 * Ported from `internal/core/vocab_test.go`.
 *
 * `@vale-ts/core` does not depend on the speller -- an entry that writes
 * `flags:` is the only thing that needs one -- so the expander is injected.
 * Go has no such split: its vocabulary reader calls the speller directly, and
 * two of the cases below assert on messages that come from it. The resolver
 * registered here is the one `vale-ts` registers, so those messages are the
 * real ones rather than a stand-in's.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { expand, expandWith } from "@vale-ts/spell";
import {
	BUILTIN_AFFIX,
	type ExpandFunc,
	newVocabulary,
	readVocabYAML,
	setAffixResolver,
	type Vocabulary,
} from "../src/vocab.ts";

beforeAll(() => {
	setAffixResolver((name: string, affPath: string): ExpandFunc => {
		if (affPath !== "") {
			return (word, flags) => expandWith(affPath, word, flags);
		}
		if (name === "" || name === BUILTIN_AFFIX) {
			return (word, flags) => expand(word, flags);
		}
		throw new Error(`'${name}.aff' not found in config/dictionaries or $DICPATH`);
	});
});

function readVocab(src: string): Vocabulary {
	const path = nodePath.join(
		mkdtempSync(nodePath.join(tmpdir(), "vale-vocab-")),
		"vocab.yml",
	);
	writeFileSync(path, src);
	const vocab = newVocabulary();
	readVocabYAML(path, vocab);
	return vocab;
}

describe("readVocabYAML", () => {
	test("reads every entry form", () => {
		const vocab = readVocab(`
accept:
  - Node.js
  - C++
  - CI/CD
  - LaTeX:
  - failover: {flags: S}
  - config: {ignorecase: true}
  - '[Pp]ython': {regex: true}
reject:
  - k8s
  - master:
      ignorecase: true
`);

		expect(vocab.accepted).toEqual([
			"Node.js",
			"C\\+\\+",
			"CI/CD",
			"LaTeX",
			"failover",
			"failovers",
			"(?i)config",
			"[Pp]ython",
		]);
		expect(vocab.rejected).toEqual(["k8s", "(?i)master"]);
	});

	const errors: Array<[string, string]> = [
		["reject:\n  - whitelist: allowlist\n", "use a substitution rule"],
		["accept:\n  - a: {regex: true, flags: S}\n", "both 'regex' and 'flags'"],
		["accept:\n  - '(open': {regex: true}\n", "isn't a valid pattern"],
		["accept:\n  - quxelate: {flags: S9}\n", "isn't an affix flag"],
		["accept:\n  - a: {case: lower}\n", "isn't a vocabulary option"],
		[
			"accept:\n  - a: {regex: true}\n    b: {regex: true}\n",
			"a term mapped to its options",
		],
		["accept:\n  - a: [x]\n", "should map to its options"],
		["affix: nope\naccept:\n  - a: {flags: S}\n", "'nope.aff' not found"],
		// Go asserts on `gopkg.in/yaml.v3`'s "did not find expected ',' or ']'".
		// The JavaScript parser words the same failure differently, so the
		// assertion is that the unterminated list is reported at all.
		["accept: [a\n", "Flow sequence"],
	];

	test.each(errors)("rejects %p", (src, want) => {
		expect(() => readVocab(src)).toThrow(want);
	});
});
