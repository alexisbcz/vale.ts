import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Block } from "@vale-ts/core";
import { buildRule, newScope, parseDefinition } from "../src/index.ts";
import { testFile, wordTemplateConfig } from "./helpers.ts";

/**
 * Vale's own test styles, compiled.
 *
 * These are real rule definitions, which is the broadest check there is that
 * reading a definition and building a pattern from it works: between them they
 * exercise every extension point but `script` and `metric`, and most of the
 * keys each one accepts.
 */
const root = fileURLToPath(new URL("./fixtures/styles", import.meta.url));

function stylePath(): string {
	return root;
}

function rulesIn(style: string): string[] {
	return readdirSync(join(root, style))
		.filter((name) => name.endsWith(".yml"))
		.sort();
}

for (const style of ["demo", "Bugs"]) {
	describe(`the ${style} style compiles`, () => {
		for (const name of rulesIn(style)) {
			test(name, () => {
				const path = join(root, style, name);
				const generic = parseDefinition(readFileSync(path, "utf8"), path);
				generic.name = `${style}.${name.slice(0, -4)}`;
				generic.path = path;
				if (generic.level === undefined) generic.level = "warning";
				if (
					generic.scope === undefined &&
					generic.extends !== "sequence" &&
					generic.extends !== "metric" &&
					generic.extends !== "readability"
				) {
					generic.scope = ["text"];
				}

				const cfg = wordTemplateConfig();
				cfg.addStylesPath(stylePath());

				const rule = buildRule(cfg, generic);
				// A `consistency` rule names itself after the last pair it was
				// given, so the rule's own name is only a prefix of it.
				expect(rule.fields().name).toStartWith(`${style}.${name.slice(0, -4)}`);

				// A compiled rule must also be runnable: its scope has to parse
				// and its pattern has to accept text.
				const scope = newScope(rule.fields().scope);
				const blk = new Block(
					"",
					"The Simple Sentence here is a test of the thing.",
					"text",
				);
				if (scope.matches(blk)) {
					expect(() => rule.run(blk, testFile(), cfg)).not.toThrow();
				}
			});
		}
	});
}
