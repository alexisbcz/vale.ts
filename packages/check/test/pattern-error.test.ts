import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValeError } from "@vale-ts/core";
import { patternError } from "../src/index.ts";
import { tempDir } from "./helpers.ts";

/**
 * Vale wraps a rule's tokens in a larger pattern before compiling, so the
 * engine's message quotes the whole thing. Each of the rule's own patterns is
 * compiled alone to find which one is at fault.
 *
 * The engine's wording is this port's rather than Go's, so the messages below
 * are `@vale-ts/regex`'s; the *placement* is what matters and is pinned here.
 */
describe("patternError", () => {
	const path = join(tempDir(), "Rule.yml");
	const src =
		"extends: existence\nmessage: x\ntokens:\n  - fine\n  - '(unclosed'\nexceptions:\n  - 'a[b'\n";
	writeFileSync(path, src);

	const wrapped = new Error(
		"error parsing regexp: missing closing ) in `(?m)\\b(?:fine|(unclosed)\\b`",
	);

	const cases: Array<[string, string[], number, string]> = [
		["the token that fails", ["fine", "(unclosed"], 5, "(unclosed"],
		// A flag group Vale added, `(?-i)` on an exception, is not in the file,
		// so the pattern is shown without it.
		["a flag group Vale added", ["(?-i)a[b"], 7, "a[b"],
		["not in the file as written", ["(gone"], 1, "(in '(gone')"],
		["none fails alone", ["fine"], 1, wrapped.message],
	];

	for (const [name, patterns, line, msg] of cases) {
		test(name, () => {
			const err = patternError(wrapped, path, ...patterns);
			expect(err).toBeInstanceOf(ValeError);
			expect(err.line).toBe(line);
			expect(err.msg).toContain(msg);
		});
	}

	test("a failing pattern is reported as invalid", () => {
		const err = patternError(wrapped, path, "fine", "(unclosed");
		expect(err.msg).toContain("Invalid pattern:");
	});

	test("whitespace-only patterns are skipped", () => {
		const err = patternError(wrapped, path, "   ", "");
		expect(err.line).toBe(1);
		expect(err.msg).toBe(wrapped.message);
	});
});
