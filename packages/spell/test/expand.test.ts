import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expand, expandWith, expandWithContent } from "../src/index.ts";

test("expand turns a vocabulary entry's flags into its forms", () => {
	const cases: Array<[string, string, string[]]> = [
		["failover", "S", ["failover", "failovers"]],
		["rebase", "DG", ["rebase", "rebased", "rebasing"]],
		["Grafana", "M", ["Grafana", "Grafana's"]],
		["CI/CD", "M", ["CI/CD", "CI/CD's"]],
		["kubeadm", "", ["kubeadm"]],
	];
	for (const [word, flags, want] of cases) {
		expect(expand(word, flags).sort(), `${word}/${flags}`).toEqual(
			want.slice().sort(),
		);
	}
});

test("expand refuses an entry it cannot read", () => {
	// A flag the affix file does not define, and flags with no word.
	expect(() => expand("quxelate", "S9")).toThrow();
	expect(() => expand("", "S")).toThrow();
});

// A project's own `.aff` is read in the encoding its SET names.
test("expandWith reads a file in the encoding SET declares", () => {
	const dir = mkdtempSync(join(tmpdir(), "vale-spell-"));
	const path = join(dir, "de_mini.aff");
	// `\xfc` is ü in ISO8859-1 and not valid UTF-8, so the SET line decides.
	const aff = "SET ISO8859-1\nSFX N Y 1\nSFX N 0 n e\nSFX U Y 1\nSFX U 0 \xfcr .\n";
	writeFileSync(
		path,
		Uint8Array.from(aff, (c) => c.charCodeAt(0)),
	);

	expect(expandWith(path, "Schnittstelle", "NU").sort()).toEqual([
		"Schnittstelle",
		"Schnittstellen",
		"Schnittstelleür",
	]);

	// S is a flag in the default file, not in this one.
	expect(() => expandWith(path, "Schnittstelle", "S")).toThrow();
});

test("expandWithContent needs no file", () => {
	const aff = "SET UTF-8\nSFX N Y 1\nSFX N 0 n e\n";
	expect(expandWithContent(aff, "Schnittstelle", "N")).toEqual([
		"Schnittstelle",
		"Schnittstellen",
	]);
	expect(() => expandWithContent(aff, "Schnittstelle", "Q")).toThrow();
});

test("expand builds the cross-product of a prefix and a suffix", () => {
	// `A` is the built-in file's `re` prefix and `S` its plural suffix.
	expect(expand("bind", "AS").sort()).toEqual([
		"bind",
		"binds",
		"rebind",
		"rebinds",
	]);
});
