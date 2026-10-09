/** Shared scaffolding for the tests; not a test file itself. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Script } from "../src/index.ts";

export const FIXTURES = join(import.meta.dir, "fixtures");

/** The modules Vale allows a rule to import. */
export const VALE_MODULES = ["text", "fmt", "math"] as const;

/** Runs `source` and reads one global back out. */
export function runFor(
	source: string,
	read: string,
	globals: Record<string, unknown> = {},
): unknown {
	const script = Script.compile(source);
	for (const [name, value] of Object.entries(globals)) script.add(name, value);
	const compiled = script.clone();
	compiled.run();
	return compiled.get(read);
}

/**
 * Evaluates one expression.
 *
 * The expression is wrapped in a definition rather than compiled on its own,
 * so that the value can be read back through the public API.
 */
export function evaluate(
	expression: string,
	globals: Record<string, unknown> = {},
): unknown {
	return runFor(`__out__ := (${expression})`, "__out__", globals);
}

/** `evaluate`, with `text`, `math` and `fmt` already imported. */
export function evaluateWithStdlib(expression: string): unknown {
	const preamble =
		'text := import("text")\nmath := import("math")\nfmt := import("fmt")\n';
	return runFor(`${preamble}__out__ := (${expression})`, "__out__");
}

export function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

/**
 * The body of a block scalar such as `script: |` from a fixture.
 *
 * A hand-rolled reader rather than a YAML parser: the package has no YAML
 * dependency, and what the tests need from these files is one indented block.
 */
export function blockScalar(yaml: string, key: string): string {
	const lines = yaml.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`${key}: |`));
	if (start < 0) throw new Error(`no block scalar '${key}' in fixture`);

	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() !== "" && !line.startsWith("  ")) break;
		body.push(line.slice(2));
	}
	while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
	return `${body.join("\n")}\n`;
}

/** The value of a plain `key: value` line, quotes stripped. */
export function scalar(yaml: string, key: string): string {
	for (const line of yaml.split("\n")) {
		if (!line.startsWith(`${key}:`)) continue;
		const value = line.slice(key.length + 1).trim();
		return value.replace(/^["'](.*)["']$/, "$1");
	}
	throw new Error(`no scalar '${key}' in fixture`);
}

/** Runs a `script` rule the way Vale's `Script.Run` does. */
export function runScriptRule(source: string, scope: string): unknown {
	const script = Script.compile(source, { modules: VALE_MODULES });
	script.add("scope", "");
	const compiled = script.clone();
	compiled.set("scope", scope);
	compiled.run();
	return compiled.get("matches");
}

/** Runs a `suggest` action the way Vale's `suggest` fixer does. */
export function runAction(source: string, match: string): unknown {
	const script = Script.compile(source, { modules: VALE_MODULES });
	script.add("match", "");
	const compiled = script.clone();
	compiled.set("match", match);
	compiled.run();
	return compiled.get("suggestions");
}
