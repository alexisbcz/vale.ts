/**
 * How a failure is rendered, per output format.
 *
 * A port of `cmd/vale/error_test.go`: the fields are read rather than a banner
 * parsed back apart, so an `E201` wrapped in an `E100` is still the `E201` and
 * a message with a blank line in it reaches JSON whole.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { newE100, newE201FromTarget, ValeError } from "@vale-ts/core";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { asValeError, banner, showError } from "../src/error.ts";
import { setTerminal } from "../src/tty.ts";
import { withTempDir } from "./helpers.ts";

beforeEach(() => {
	setTerminal(false, false);
});

/** What `showError` wrote. */
function render(err: unknown, style: string): string {
	let out = "";
	showError(err, style, (text) => {
		out += text;
	});
	return out;
}

describe("showError", () => {
	test("a runtime error in each format", () => {
		const err = newE100("ls-metrics", new Error("one argument expected"));

		expect(render(err, "line").trim()).toBe(
			"[ls-metrics]:E100:one argument expected",
		);

		const json = render(err, "JSON");
		expect(json).toBe(`{
  "Line": 0,
  "Path": "",
  "Text": "one argument expected",
  "Code": "E100",
  "Span": 0
}
`);

		expect(render(err, "CLI")).toBe(
			"E100 [ls-metrics] Runtime error\n\n" +
				"one argument expected\n\n" +
				"Execution stopped with code 2.\n",
		);
	});

	test("an E201 keeps its position through the E100 around it", () => {
		withTempDir((dir) => {
			const ini = path.join(dir, ".vale.ini");
			writeFileSync(
				ini,
				"StylesPath = styles\n[*.md]\nBasedOnStyles = Nope\n",
			);

			const e201 = newE201FromTarget(
				"first paragraph\n\nsecond paragraph",
				"Nope",
				ini,
			);
			const err = newE100("stdin", e201);

			const json = render(err, "JSON");
			for (const want of [
				'"Code": "E201"',
				'"Line": 3',
				'"Span": 17',
				'"Text": "first paragraph\\n\\nsecond paragraph"',
			]) {
				expect(json).toContain(want);
			}

			expect(render(err, "line").trim()).toBe(
				`${ini.replaceAll("\\", "/")}:3:E201:first paragraph`,
			);
		});
	});

	test("line output keeps only the first line of a message", () => {
		const err = new ValeError({
			code: "E100",
			context: "stdin",
			msg: "first\nsecond",
		});
		expect(render(err, "line").trim()).toBe("[stdin]:E100:first");
	});

	test("an error with neither a path nor a context is just its code", () => {
		const err = new ValeError({ code: "E100", msg: "bare" });
		expect(render(err, "line").trim()).toBe("E100:bare");
	});

	test("a template is not a format an error is rendered in", () => {
		// Anything that is not JSON or line falls through to the banner.
		const err = newE100("x", new Error("m"));
		expect(render(err, "custom.tmpl")).toContain("E100 [x] Runtime error");
	});

	test("something that is not Vale's error prints its own message", () => {
		expect(render(new Error("boom"), "CLI")).toBe("boom\n");
	});
});

describe("asValeError", () => {
	test("wraps a plain error as an E100", () => {
		const ve = asValeError(new Error("m"));
		expect(ve.code).toBe("E100");
		expect(ve.msg).toBe("m");
	});

	test("passes Vale's own error through", () => {
		const err = newE100("c", new Error("m"));
		expect(asValeError(err)).toBe(err);
	});
});

describe("banner", () => {
	test("an excerpt is numbered, and the error's line is marked", () => {
		const err = new ValeError({
			code: "E201",
			path: "/p/.vale.ini",
			line: 2,
			span: 3,
			msg: "bad value",
			excerpt: [
				{ number: 1, text: "one", marked: false },
				{ number: 2, text: "two", marked: true },
			],
		});

		expect(banner(err)).toBe(
			"E201 Invalid value [/p/.vale.ini:2:3]:\n\n" +
				"   1  one\n" +
				"   2* two\n\n" +
				"bad value\n\n" +
				"Execution stopped with code 2.",
		);
	});
});
