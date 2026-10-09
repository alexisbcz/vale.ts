/**
 * Vale's own failures: where they point, and what they show above the message.
 *
 * Ported from `internal/core/error_test.go`.
 *
 * `TestGutterHonorsNoColor` is left out: Go renders an excerpt's gutter with
 * `pterm` and the test checks that `--no-color` keeps the escape codes out of
 * it. This port keeps an error's parts apart -- `ValeError.excerpt` is a list
 * of lines, never a rendered string -- so there is no gutter to colour and
 * nothing for the test to assert.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import {
	newE201FromKey,
	newE201FromPosition,
	newE201FromTarget,
} from "../src/errors.ts";

function tempFile(name: string, body: string): string {
	const dir = mkdtempSync(nodePath.join(tmpdir(), "vale-errors-"));
	const path = nodePath.join(dir, name);
	writeFileSync(path, body);
	return path;
}

describe("newE201", () => {
	// Shows no excerpt for a value that isn't in the file, rather than every
	// line of it. Go tests the unexported `annotate` directly; here it is
	// reached through the only thing that calls it.
	test("a value that is not in the file has no line and no excerpt", () => {
		const path = tempFile("values.ini", "a = 1\nb = 2\n");
		const err = newE201FromTarget("msg", "missing", path);

		expect(err.line).toBe(0);
		expect(err.excerpt).toEqual([]);
	});

	test("a value that is in the file carries its line and the lines around it", () => {
		const path = tempFile("values.ini", "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\n");
		const err = newE201FromTarget("msg", "c = 3", path);

		expect(err.code).toBe("E201");
		expect(err.line).toBe(3);
		expect(err.span).toBe(1);
		expect(err.excerpt.map((l) => l.number)).toEqual([1, 2, 3, 4, 5]);
		expect(err.excerpt.filter((l) => l.marked).map((l) => l.number)).toEqual([3]);
	});

	test("a line named by position", () => {
		const path = tempFile("values.ini", "a = 1\nb = 2\n");
		expect(newE201FromPosition("msg", path, 2).line).toBe(2);
	});

	// A file that cannot be read leaves an E100 rather than an E201 pointing
	// into nothing.
	test("a missing file falls back to an E100", () => {
		const err = newE201FromTarget("msg", "x", "/nonexistent/.vale.ini");
		expect(err.code).toBe("E100");
		expect(err.message).toBe("msg");
	});
});

describe("newE201FromKey", () => {
	const src =
		"StylesPath = styles\n\n# Nope is only mentioned here.\n[*.md]\nBasedOnStyles = Vale, Nope\n";

	test("points at the key's line and the value's column", () => {
		const ini = tempFile(".vale.ini", src);

		const err = newE201FromKey([ini], "BasedOnStyles", (v) => v === "Nope", "msg");

		expect(err.code).toBe("E201");
		expect(err.title()).toContain(`${ini.replaceAll("\\", "/")}:5:23]`);
	});

	// A value no file sets was computed rather than written, so there is no
	// line to point at.
	test("falls back to an E100 when no file sets the value", () => {
		const ini = tempFile(".vale.ini", src);

		const err = newE201FromKey([ini], "BasedOnStyles", (v) => v === "Other", "msg");

		// Go asserts on the rendered `E100 [BasedOnStyles]` prefix; the port
		// keeps the code and the context as fields.
		expect(err.code).toBe("E100");
		expect(err.context).toBe("BasedOnStyles");
	});
});
