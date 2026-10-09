/**
 * Named scopes: the YAML files under `config/scopes` that give a scope
 * expression a name.
 *
 * Ported from `internal/core/scopes_test.go`. `LoadScopes` returns an error in
 * Go and throws here, and the configurations are built with `--no-global` so
 * that only the styles path the test writes is searched -- Go's test counts the
 * scopes exactly, which assumes the machine's default styles path defines none.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { type Config, newConfig, newFlags, SCOPE_DIR } from "../src/config.ts";

function scopeConfig(files: Record<string, string>): Config {
	const root = mkdtempSync(nodePath.join(tmpdir(), "vale-scopes-"));
	for (const [name, body] of Object.entries(files)) {
		const path = nodePath.join(root, SCOPE_DIR, name);
		mkdirSync(nodePath.dirname(path), { recursive: true });
		writeFileSync(path, body);
	}

	const cfg = newConfig(newFlags({ ignoreGlobal: true }));
	cfg.addStylesPath(root);
	return cfg;
}

describe("loadScopes", () => {
	test("reads every YAML file on the search paths", () => {
		const cfg = scopeConfig({
			"Sections.yml":
				"methods: 'doc(section:has(> h2:contains(\"Methods\")))'\nlead: text & doc(h1 + p)\n",
			"More.yaml": 'results: doc(section:has(> h2:contains("Results")))\n',
			// The same name with the same expression, from another file, is fine.
			"Again.yml": "lead: text & doc(h1 + p)\n",
			"notes.txt": "not: read\n",
		});

		cfg.loadScopes();

		const want: Record<string, string> = {
			methods: 'doc(section:has(> h2:contains("Methods")))',
			lead: "text & doc(h1 + p)",
			results: 'doc(section:has(> h2:contains("Results")))',
		};
		expect(cfg.scopes).toEqual(want);
	});

	test("a styles path with no scopes directory loads nothing", () => {
		const cfg = newConfig(newFlags({ ignoreGlobal: true }));
		cfg.addStylesPath(mkdtempSync(nodePath.join(tmpdir(), "vale-scopes-")));

		cfg.loadScopes();
		expect(cfg.scopes).toEqual({});
	});

	const rejects: Array<{ name: string; body: string; want: string }> = [
		{ name: "reserved", body: "heading: doc(h1)\n", want: "a scope Vale defines" },
		{ name: "bad name", body: "'my scope': doc(h1)\n", want: "not a scope name" },
		{ name: "empty", body: "methods: ''\n", want: "needs a scope" },
		{ name: "conflict", body: "methods: doc(h1)\n---\n", want: "already defined" },
		{
			name: "not a mapping",
			body: "- methods\n",
			want: "a mapping of names to scopes",
		},
	];

	test.each(rejects)("rejects $name", ({ name, body, want }) => {
		const files =
			name === "conflict"
				? { "A.yml": "methods: doc(h1)\n", "B.yml": "methods: doc(h2)\n" }
				: { "Bad.yml": body };
		const cfg = scopeConfig(files);

		expect(() => cfg.loadScopes()).toThrow(want);
	});
});
