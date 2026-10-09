import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BaseCheck } from "../src/index.ts";
import { flatten, parseDefinition } from "../src/index.ts";
import { testConfig, withStyles } from "./helpers.ts";

const parentRule = `extends: existence
message: "parent: '%s'"
level: suggestion
ignorecase: true
tokens:
  - alpha
  - beta
tests:
  - name: parent case
    input: "alpha"
    contains: parent
`;

function flattenChild(
	files: Record<string, string>,
	body: string,
): BaseCheck {
	const sp = withStyles(files);
	const cfg = testConfig();
	cfg.addStylesPath(sp);

	const path = join(sp, "Child", "Rule.yml");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);

	return flatten(cfg, parseDefinition(body, path), path, []);
}

test("a child's keys win, and `+`/`-` edit the parent's lists", () => {
	const got = flattenChild(
		{ "Base/Words.yml": parentRule },
		`extends: Base.Words
message: "child: '%s'"
level: error
tokens+:
  - gamma
tokens-:
  - alpha
`,
	);

	expect(got.extends).toBe("existence");
	expect(got.message).toBe("child: '%s'");
	expect(got.level).toBe("error");
	// An un-overridden parent key survives.
	expect(got.ignorecase).toBe(true);
	// A parent's cases are not inherited.
	expect(Object.hasOwn(got, "tests")).toBe(false);
	expect(got.tokens).toEqual(["beta", "gamma"]);
});

test("`+` merges a map and `-` removes its keys", () => {
	const got = flattenChild(
		{
			"Base/Swaps.yml": `extends: substitution
message: "use '%s'"
swap:
  aa: one
  bb: two
`,
		},
		`extends: Base.Swaps
swap+:
  bb: TWO
  cc: three
swap-:
  - aa
`,
	);

	expect(got.swap).toEqual({ bb: "TWO", cc: "three" });
});

describe("what inheritance refuses", () => {
	const cases: Array<[string, string, string]> = [
		["missing parent", "extends: Base.Missing\n", "does not exist on the search path"],
		["builtin parent", "extends: Vale.Terms\n", "generated at runtime"],
		[
			"remove absent entry",
			"extends: Base.Words\ntokens-: [omega]\n",
			"no entry 'omega'",
		],
		[
			"replace and edit",
			"extends: Base.Words\ntokens: [x]\ntokens+: [y]\n",
			"pick one",
		],
		["op on scalar", "extends: Base.Words\nmessage+: [x]\n", "assign it directly"],
		[
			"op without parent",
			"extends: existence\nmessage: x\ntokens+: [x]\n",
			"needs a parent",
		],
		["cycle", "extends: Loop.A\n", "cycle"],
	];

	for (const [name, body, wants] of cases) {
		test(name, () => {
			let message = "";
			try {
				flattenChild(
					{
						"Base/Words.yml": parentRule,
						"Loop/A.yml": "extends: Loop.B\nmessage: x\n",
						"Loop/B.yml": "extends: Loop.A\nmessage: x\n",
					},
					body,
				);
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).toContain(wants);
		});
	}
});

test("a chain flattens top-down", () => {
	const got = flattenChild(
		{
			"Base/Words.yml": parentRule,
			"Mid/Words.yml": "extends: Base.Words\nlevel: warning\ntokens+: [gamma]\n",
		},
		`extends: Mid.Words
message: "leaf"
`,
	);

	expect(got.extends).toBe("existence");
	expect(got.level).toBe("warning");
	expect(got.message).toBe("leaf");
	expect((got.tokens as string[]).length).toBe(3);
});
