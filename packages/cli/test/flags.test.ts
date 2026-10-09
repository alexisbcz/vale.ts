/**
 * Flag parsing: every flag Vale declares, and the four spellings `pflag`
 * accepts for each one.
 */

import { describe, expect, test } from "bun:test";
import { FLAGS, FlagError, parseFlags } from "../src/flags.ts";

describe("parseFlags", () => {
	test("defaults match newFlags", () => {
		const { flags, args } = parseFlags([]);
		expect(args).toEqual([]);
		expect(flags.output).toBe("CLI");
		expect(flags.glob).toBe("*");
		expect(flags.inExt).toBe(".txt");
		expect(flags.version).toBe(false);
	});

	test("every declared flag is settable both ways", () => {
		for (const spec of FLAGS) {
			if (spec.kind === "bool") {
				const joined = parseFlags([`--${spec.name}`]).flags;
				expect(joined[spec.field]).toBe(true);

				const explicit = parseFlags([`--${spec.name}=false`]).flags;
				expect(explicit[spec.field]).toBe(false);
				continue;
			}

			const equals = parseFlags([`--${spec.name}=x`]).flags;
			expect(equals[spec.field]).toBe("x");

			const spaced = parseFlags([`--${spec.name}`, "y"]).flags;
			expect(spaced[spec.field]).toBe("y");
		}
	});

	test("a flag's field is the one Vale reads", () => {
		// The names and the fields differ on purpose: `--config` is the path to
		// the configuration, while `--path` is the path stdin is given.
		const { flags } = parseFlags([
			"--config=/tmp/.vale.ini",
			"--path=docs/a.md",
			"--ext=.md",
			"--minAlertLevel=error",
			"--no-wrap",
			"--ignore-syntax",
			"--no-global",
			"--mode-compat",
			"--mode-rev-compat",
		]);
		expect(flags.path).toBe("/tmp/.vale.ini");
		expect(flags.inPath).toBe("docs/a.md");
		expect(flags.inExt).toBe(".md");
		expect(flags.alertLevel).toBe("error");
		expect(flags.wrap).toBe(true);
		expect(flags.simple).toBe(true);
		expect(flags.ignoreGlobal).toBe(true);
		expect(flags.local).toBe(true);
		expect(flags.remote).toBe(true);
	});

	test("short forms, grouped and separate", () => {
		expect(parseFlags(["-v"]).flags.version).toBe(true);
		expect(parseFlags(["-h"]).flags.help).toBe(true);

		const both = parseFlags(["-vh"]).flags;
		expect(both.version).toBe(true);
		expect(both.help).toBe(true);

		expect(parseFlags(["-v=false"]).flags.version).toBe(false);
	});

	test("arguments and flags may be interspersed", () => {
		const { flags, args } = parseFlags([
			"a.md",
			"--output",
			"JSON",
			"b.md",
			"--sort",
			"dir",
		]);
		expect(flags.output).toBe("JSON");
		expect(flags.sorted).toBe(true);
		expect(args).toEqual(["a.md", "b.md", "dir"]);
	});

	test("-- ends flag parsing", () => {
		const { flags, args } = parseFlags(["--sort", "--", "--output=JSON", "-v"]);
		expect(flags.sorted).toBe(true);
		expect(flags.output).toBe("CLI");
		expect(args).toEqual(["--output=JSON", "-v"]);
	});

	test("a lone dash is an argument", () => {
		expect(parseFlags(["-"]).args).toEqual(["-"]);
	});

	test("an empty value is kept", () => {
		expect(parseFlags(["--output="]).flags.output).toBe("");
	});

	test("an unknown long flag is rejected", () => {
		expect(() => parseFlags(["--bogus"])).toThrow(FlagError);
		expect(() => parseFlags(["--bogus"])).toThrow("unknown flag: --bogus");
	});

	test("an unknown short flag is rejected", () => {
		expect(() => parseFlags(["-z"])).toThrow("unknown shorthand flag: 'z' in -z");
	});

	test("a string flag at the end of the line needs its argument", () => {
		expect(() => parseFlags(["--output"])).toThrow(
			"flag needs an argument: --output",
		);
	});

	test("a boolean flag rejects a value that is not one", () => {
		expect(() => parseFlags(["--sort=maybe"])).toThrow(
			'invalid argument "maybe" for "--sort" flag',
		);
		// The shortcode is part of the name an error uses.
		expect(() => parseFlags(["--help=maybe"])).toThrow('"-h, --help" flag');
	});

	test("the last of a repeated flag wins", () => {
		expect(parseFlags(["--output=line", "--output=JSON"]).flags.output).toBe(
			"JSON",
		);
	});

	test("a value that looks like a flag is still a value", () => {
		expect(parseFlags(["--glob", "!*.py"]).flags.glob).toBe("!*.py");
		expect(parseFlags(["--filter=.Level == 'error'"]).flags.filter).toBe(
			".Level == 'error'",
		);
	});
});
