/**
 * Ports of `internal/textfsm/textfsm_test.go`, plus the joining of a `List`
 * value's captures that `internal/core/view.go` does.
 */

import { describe, expect, test } from "bun:test";
import { type Capture, joinCaptures, parseTemplate } from "../src/textfsm.ts";

const COMMIT = `Value Subject (.+)
Value List Body (.*)
Value List Trailer ([A-Z][\\w-]+: .+)

Start
  ^\${Subject} -> Body

Body
  ^\${Trailer}
  ^\${Body}
`;

test("a commit message yields a subject, a body and its trailers", () => {
	const recs = parseTemplate(COMMIT).run(
		"fix: report the shortfall\n\nThe scope that fell short.\nSecond line.\n\nSigned-off-by: J <j@x>\n",
	);
	expect(recs).toHaveLength(1);
	const r = recs[0]!;

	expect(r.Subject![0]).toEqual({
		text: "fix: report the shortfall",
		line: 1,
		column: 1,
	});
	expect(r.Trailer).toHaveLength(1);
	expect(r.Trailer![0]!.line).toBe(6);

	// Body takes every line the trailer rule left, including blanks.
	expect(r.Body!.map((c) => c.text).join("|")).toBe(
		"|The scope that fell short.|Second line.||",
	);
});

const TRANSCRIPT = `Value Role (user|assistant)
Value List Text (.*)

Start
  ^(?:user|assistant): -> Continue.Record
  ^\${Role}: \${Text}
  ^\${Text}
`;

// Record and Continue, pinned together: a role line closes the previous turn,
// then is read again to open its own.
test("Continue.Record closes a record and rereads the line", () => {
	const recs = parseTemplate(TRANSCRIPT).run(
		"user: hi\nthere\nassistant: hello\nuser: bye\n",
	);
	expect(recs).toHaveLength(3);

	const first = recs[0]!;
	expect(first.Role![0]!.text).toBe("user");
	expect(first.Text).toHaveLength(2);
	expect(first.Text![1]!.text).toBe("there");

	const last = recs[2]!;
	expect(last.Role![0]!.text).toBe("user");
	expect(last.Text![0]!.text).toBe("bye");
	expect(last.Text![0]!.column).toBe(7);
});

describe("a template that cannot be read", () => {
	const cases: Array<[string, string, RegExp]> = [
		["no values", "Start\n  ^x\n", /at least one Value/],
		["no start", "Value A (.)\n\nFoo\n  ^${A}\n", /Start state/],
		["undefined value", "Value A (.)\n\nStart\n  ^${B}\n", /undefined Value/],
		[
			"undefined state",
			"Value A (.)\n\nStart\n  ^${A} -> Nowhere\n",
			/not defined/,
		],
		[
			"bad option",
			"Value Sideways A (.)\n\nStart\n  ^${A}\n",
			/unknown Value option/,
		],
		[
			"continue with state",
			"Value A (.)\n\nStart\n  ^${A} -> Continue Foo\n\nFoo\n  ^${A}\n",
			/cannot change state/,
		],
		["a rule before any state", "Value A (.)\n\n  ^${A}\n", /before any state/],
		[
			"a value defined twice",
			"Value A (.)\nValue A (.)\n\nStart\n  ^${A}\n",
			/defined twice/,
		],
		[
			"a state defined twice",
			"Value A (.)\n\nStart\n  ^${A}\n\nStart\n  ^${A}\n",
			/state "Start" defined twice/,
		],
		[
			"two states on one rule",
			"Value A (.)\n\nStart\n  ^${A} -> Foo Bar\n\nFoo\n  ^${A}\n\nBar\n  ^${A}\n",
			/names two states/,
		],
	];

	for (const [name, src, want] of cases) {
		test(name, () => {
			expect(() => parseTemplate(src)).toThrow(want);
		});
	}
});

test("an Error action stops the run and names the line", () => {
	const t = parseTemplate(
		'Value A (\\d+)\n\nStart\n  ^${A}\n  ^. -> Error "not a number"\n',
	);
	expect(() => t.run("1\nx\n")).toThrow("line 2: not a number");
});

test("Required drops a record the value is missing from", () => {
	const t = parseTemplate(
		"Value Required A (a+)\nValue B (b+)\n\nStart\n  ^${A} -> Record\n  ^${B} -> Record\n",
	);
	const recs = t.run("bb\naa\nbb\n");
	expect(recs).toHaveLength(1);
	expect(recs[0]!.A![0]!.text).toBe("aa");
});

test("an empty EOF state drops the record implied at end of input", () => {
	const t = parseTemplate("Value A (a+)\n\nStart\n  ^${A}\n\nEOF\n");
	expect(t.run("aa\n")).toHaveLength(0);
});

test("Filldown carries a value into the next record", () => {
	const t = parseTemplate(
		"Value Filldown Host (\\S+)\nValue Line (\\S+)\n\nStart\n  ^host (?:${Host})\n  ^- ${Line} -> Record\n",
	);
	const recs = t.run("host a\n- one\n- two\n");
	// Two from the Record actions, and a third at end of input: the carried
	// Host alone is enough to make the last record non-empty.
	expect(recs).toHaveLength(3);
	expect(recs[0]!.Host![0]!.text).toBe("a");
	expect(recs[1]!.Host![0]!.text).toBe("a");
	expect(recs[1]!.Line![0]!.text).toBe("two");
	expect(recs[2]!.Line).toBeUndefined();
});

test("Clearall drops the carried values too", () => {
	const t = parseTemplate(
		"Value Filldown A (\\S+)\nValue B (\\S+)\n\nStart\n  ^a ${A}\n  ^b ${B} -> Record\n  ^reset -> Clearall\n",
	);
	const recs = t.run("a one\nb x\nreset\nb y\n");
	expect(recs).toHaveLength(2);
	expect(recs[0]!.A![0]!.text).toBe("one");
	expect(recs[1]!.A).toBeUndefined();
});

test("a column counts characters, not code units", () => {
	const t = parseTemplate("Value A (\\S+)\n\nStart\n  ^héllo ${A}\n");
	const recs = t.run("héllo wörld\n");
	const got = recs[0]!.A![0]!;
	expect(got.text).toBe("wörld");
	expect(got.column).toBe(7);
});

test("a comment and the blank line that ends the values are skipped", () => {
	const t = parseTemplate(
		"# a template\nValue A (.+)\n\n# the only state\nStart\n  # the only rule\n  ^${A}\n",
	);
	expect(t.values).toEqual([
		{ name: "A", regex: ".+", filldown: false, required: false, list: false },
	]);
	expect(t.run("x\n")[0]!.A![0]!.text).toBe("x");
});

test("Key and Fillup are accepted without changing what is captured", () => {
	const t = parseTemplate("Value Key,List A (.+)\n\nStart\n  ^${A}\n");
	expect(t.values[0]!.list).toBe(true);
});

describe("joinCaptures", () => {
	const cap = (text: string, line: number, column = 1): Capture => ({
		text,
		line,
		column,
	});

	test("captures on consecutive lines are one value", () => {
		expect(joinCaptures([cap("one", 2), cap("two", 3), cap("three", 4)])).toEqual([
			{ text: "one\ntwo\nthree", line: 2, column: 1 },
		]);
	});

	test("a gap in the lines starts another value", () => {
		expect(joinCaptures([cap("one", 2), cap("two", 5)])).toEqual([
			{ text: "one", line: 2, column: 1 },
			{ text: "two", line: 5, column: 1 },
		]);
	});

	test("a change of column starts another value", () => {
		expect(joinCaptures([cap("one", 2, 1), cap("two", 3, 5)])).toEqual([
			{ text: "one", line: 2, column: 1 },
			{ text: "two", line: 3, column: 5 },
		]);
	});

	test("a run that is only whitespace is dropped", () => {
		expect(joinCaptures([cap("", 1), cap("  ", 2)])).toEqual([]);
		expect(joinCaptures([])).toEqual([]);
	});

	test("trailing blank lines are trimmed, inner ones kept", () => {
		expect(
			joinCaptures([
				cap("one", 1),
				cap("", 2),
				cap("two", 3),
				cap("", 4),
				cap("", 5),
			]),
		).toEqual([{ text: "one\n\ntwo", line: 1, column: 1 }]);
	});

	// What `View.applyTemplate` reports for the Commit view: a body that is
	// two paragraphs is one value, and the trailer is its own.
	test("a commit message's body and trailer", () => {
		const recs = parseTemplate(COMMIT).run(
			"fix: a thing\n\nFirst paragraph.\n\nSecond paragraph.\n\nSigned-off-by: J <j@x.y>\n",
		);
		const r = recs[0]!;
		expect(joinCaptures(r.Body!)).toEqual([
			{ text: "\nFirst paragraph.\n\nSecond paragraph.", line: 2, column: 1 },
		]);
		expect(joinCaptures(r.Trailer!)).toEqual([
			{ text: "Signed-off-by: J <j@x.y>", line: 7, column: 1 },
		]);
	});

	// A value the template never filled has no captures, which is what lets a
	// view report the scope as one empty value.
	test("an unfilled value has nothing to join", () => {
		const t = parseTemplate(
			"Value Subject (.+)\nValue List Trailer ([A-Z][\\w-]+: .+)\n\nStart\n  ^${Trailer}\n  ^${Subject}\n",
		);
		const recs = t.run("fix: a thing\n");
		expect(joinCaptures(recs[0]!.Trailer ?? [])).toEqual([]);
	});
});

// Vale's own Transcript view: only the model's turns are captured.
test("the Transcript view's states", () => {
	const t = parseTemplate(`Value List Assistant (.*)
Value List User (.*)

Start
  ^assistant: \${Assistant} -> Assistant
  ^user: \${User} -> User

Assistant
  ^(?:user|assistant): -> Continue.Record
  ^assistant: \${Assistant}
  ^user: \${User} -> User
  ^\${Assistant}

User
  ^(?:user|assistant): -> Continue.Record
  ^user: \${User}
  ^assistant: \${Assistant} -> Assistant
  ^\${User}
`);

	// The fixture Vale's e2e suite runs this view over.
	const recs = t.run(
		"user: Summarize the change in one line.\n" +
			"assistant: The linter now reports where a scope fell short.\n" +
			"It's worth noting that this only affects occurence rules.\n" +
			"user: Thanks, that's clear enuf.\n",
	);
	const assistant = recs.flatMap((r) => joinCaptures(r.Assistant ?? []));

	// Two values, not one: the turn's first line starts after `assistant: `
	// and its second at the margin, and a value is placed by one column.
	expect(assistant).toEqual([
		{
			text: "The linter now reports where a scope fell short.",
			line: 2,
			column: 12,
		},
		{
			text: "It's worth noting that this only affects occurence rules.",
			line: 3,
			column: 1,
		},
	]);
	// The user's misspelling is never captured as the assistant's.
	expect(assistant.some((v) => v.text.includes("enuf"))).toBe(false);
});

// Vale's own Commit view, over the fixture its e2e suite uses: the `^#` rule
// stops the body at the comment block git appends.
test("the Commit view's body stops at the comment block", () => {
	const t = parseTemplate(`Value Subject (.+)
Value List Body (.*)
Value List Trailer ((?:BREAKING CHANGE|[A-Z][\\w-]+): .+)

Start
  ^\${Subject} -> Body

Body
  ^# -> Next
  ^\${Trailer}
  ^\${Body}
`);

	const recs = t.run(
		"fix: report the shortfall at the scope that fell short.\n" +
			"\n" +
			"Zero matches leave no occurence to point at, but the scope has a\n" +
			"position of its own.\n" +
			"\n" +
			"Signed-off-by: Joseph Kato <j@example.com>\n" +
			"# Please enter the commit message for your changes. Lines starting\n" +
			"# with '#' will be ignored, and an empty message aborts the commit.\n" +
			"#\n" +
			"# On branch occurence\n",
	);
	expect(recs).toHaveLength(1);
	const r = recs[0]!;

	expect(joinCaptures(r.Subject!)).toEqual([
		{
			text: "fix: report the shortfall at the scope that fell short.",
			line: 1,
			column: 1,
		},
	]);
	expect(joinCaptures(r.Body!)).toEqual([
		{
			text: "\nZero matches leave no occurence to point at, but the scope has a\nposition of its own.",
			line: 2,
			column: 1,
		},
	]);
	expect(joinCaptures(r.Trailer!)).toEqual([
		{ text: "Signed-off-by: Joseph Kato <j@example.com>", line: 6, column: 1 },
	]);
	// Nothing from the comment block is a body line.
	expect(r.Body!.every((c) => !c.text.startsWith("#"))).toBe(true);
});
