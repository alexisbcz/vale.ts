/**
 * Hunspell's own test fixtures: every word in a `.good` file is accepted, and
 * every line in a `.wrong` file is rejected.
 *
 * The fixtures come from the Hunspell distribution and are licensed under
 * MPL 1.1 / GPL 2.0 / LGPL 2.1; see `fixtures/hunspell/LICENSE`.
 */

import { expect, test } from "bun:test";

import { hunspellLines, hunspellSpeller, hunspellStems, words } from "./helpers.ts";

/**
 * The fixtures the checker does not pass yet, with the directive or behavior
 * each one needs.
 *
 * A fixture that starts passing fails the run until it is removed from here,
 * so the list stays honest.
 */
const unsupported: Record<string, string> = {
	hu: "a hyphenated compound whose left part is forbidden on its own",
	"limit-multiple-compounding":
		"a three-part compound one edit from a dictionary word",
	opentaal_cpdpat2: "CHECKCOMPOUNDPATTERN",
	ph2: "FORBIDDENWORD against case variants",
	nepali: "a zero-width joiner and non-joiner told apart under IGNORE",
};

/** Each expectation the fixture with this stem fails. */
function runFixture(stem: string): string[] {
	let gs: ReturnType<typeof hunspellSpeller>;
	try {
		gs = hunspellSpeller(stem);
	} catch (err) {
		return [`load: ${(err as Error).message}`];
	}

	const failures: string[] = [];
	for (const line of hunspellLines(`hunspell/${stem}.good`)) {
		for (const word of words(line)) {
			if (!gs.spell(word)) failures.push(`rejected good word ${word}`);
		}
	}
	for (const line of hunspellLines(`hunspell/${stem}.wrong`)) {
		let wrong = false;
		for (const word of words(line)) {
			if (!gs.spell(word)) wrong = true;
		}
		if (!wrong) failures.push(`accepted wrong word ${line}`);
	}
	return failures.sort();
}

const stems = hunspellStems();

test("the fixtures are present", () => {
	expect(stems.length).toBeGreaterThan(100);
});

for (const stem of stems) {
	const reason = unsupported[stem];
	test(`hunspell/${stem}`, () => {
		const failures = runFixture(stem);
		if (reason !== undefined) {
			// A listed fixture must still fail; otherwise the list is stale.
			expect(
				failures.length,
				`passes now; remove it from unsupported`,
			).toBeGreaterThan(0);
			return;
		}
		expect(failures.join("\n")).toBe("");
	});
}
