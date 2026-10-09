import { describe, expect, test } from "bun:test";
import { ValeError } from "@vale-ts/core";
import {
	Consistency,
	Existence,
	FieldError,
	Fields,
	Occurrence,
	paramValue,
	readStructureError,
	validateDefinition,
} from "../src/index.ts";
import { testConfig } from "./helpers.ts";

/**
 * A key a rule's type does not know is an error that names the key. This is
 * load-bearing UX, not a detail: it is how a style author finds a typo.
 */
test("an unrecognized key is refused, by name", () => {
	let err: unknown;
	try {
		new Existence(testConfig(), { tokens: ["x"], message: "m", tokns: ["y"] }, "");
	} catch (e) {
		err = e;
	}
	expect(err).toBeInstanceOf(ValeError);
	expect((err as ValeError).msg).toContain("tokns");
});

test("a key with the wrong type is refused, by name", () => {
	let err: unknown;
	try {
		new Occurrence(testConfig(), { token: ",", max: "lots" }, "");
	} catch (e) {
		err = e;
	}
	expect(err).toBeInstanceOf(ValeError);
	expect((err as ValeError).msg).toContain("expected type 'int'");
});

describe("values are read the way the configuration writes them", () => {
	test("a scalar lifts into a list", () => {
		const f = new Fields({ scope: "text" });
		expect(f.strings("scope")).toEqual(["text"]);
	});

	test("a number reads as a string", () => {
		const f = new Fields({ message: 5 });
		expect(f.string("message")).toBe("5");
	});

	test("a string reads as a bool", () => {
		expect(new Fields({ split: "true" }).bool("split")).toBe(true);
		expect(new Fields({ split: "false" }).bool("split", true)).toBe(false);
		expect(new Fields({ split: "" }).bool("split", true)).toBe(false);
		expect(() => new Fields({ split: "maybe" }).bool("split")).toThrow();
	});

	test("the configuration's YES and NO are translated first", () => {
		// `Vale.Spelling[split] = YES` reaches the rule as the string a bool
		// field can read.
		expect(paramValue("YES")).toBe("true");
		expect(paramValue(" no ")).toBe("false");
		expect(paramValue("30")).toBe("30");
		expect(new Fields({ split: paramValue("YES") }).bool("split")).toBe(true);
	});

	test("a string reads as a number", () => {
		expect(new Fields({ max: "30" }).int("max")).toBe(30);
		expect(new Fields({ grade: "8.5" }).float("grade")).toBe(8.5);
	});

	test("a missing key takes the default", () => {
		const f = new Fields({});
		expect(f.bool("vocab", true)).toBe(true);
		expect(f.string("affix")).toBe("");
		expect(f.strings("tokens")).toEqual([]);
	});

	test("a null value takes the default", () => {
		const f = new Fields({ vocab: null });
		expect(f.bool("vocab", true)).toBe(true);
	});

	test("an action reads a nested mapping", () => {
		const f = new Fields({ action: { name: "edit", params: ["lower"] } });
		expect(f.action("action")).toEqual({ name: "edit", params: ["lower"] });
	});

	test("`done` names the first key the rule never asked for", () => {
		const f = new Fields({ tokens: ["a"], nonsense: 1 });
		f.strings("tokens");
		let err: unknown;
		try {
			f.done();
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(FieldError);
		expect((err as FieldError).key).toBe("nonsense");
		expect((err as FieldError).detail).toContain("has invalid keys: 'nonsense'");
	});

	test("`ignore` marks a key the rule knows but does not read", () => {
		const f = new Fields({ selector: "x" });
		f.ignore("selector");
		expect(() => f.done()).not.toThrow();
	});
});

test("a field failure points at its key", () => {
	const placed = readStructureError(
		new FieldError("tokens", "has invalid keys: 'tokens'"),
		"/nonexistent/Rule.yml",
	);
	expect(placed).toBeInstanceOf(ValeError);
	expect(placed.msg).toContain("tokens");
});

describe("what every rule definition must have", () => {
	test("`extends` is required", () => {
		expect(() => validateDefinition({ message: "m" }, "R.yml")).toThrow();
	});

	test("`extends` must name an extension point", () => {
		expect(() =>
			validateDefinition({ extends: "nonsense", message: "m" }, "R.yml"),
		).toThrow();
	});

	test("a dotted `extends` names another rule, which is allowed", () => {
		expect(() =>
			validateDefinition({ extends: "Base.Words" }, "R.yml"),
		).not.toThrow();
	});

	test("`message` is required of a root rule", () => {
		expect(() => validateDefinition({ extends: "existence" }, "R.yml")).toThrow();
	});

	test("`level` must be one of the three", () => {
		expect(() =>
			validateDefinition(
				{ extends: "existence", message: "m", level: "loud" },
				"R.yml",
			),
		).toThrow();
		expect(() =>
			validateDefinition(
				{ extends: "existence", message: "m", level: "error" },
				"R.yml",
			),
		).not.toThrow();
	});

	test("`code` is deprecated", () => {
		expect(() =>
			validateDefinition(
				{ extends: "existence", message: "m", code: true },
				"R.yml",
			),
		).toThrow();
	});
});

test("`consistency` and `spelling` accept a key they do not know", () => {
	// Go reads those two with a decoder that does not refuse an unused key, so
	// this port must not refuse one either.
	expect(
		() =>
			new Consistency(
				testConfig(),
				{ either: { a: "b" }, message: "m", name: "T.C", nonsense: 1 },
				"",
			),
	).not.toThrow();
});
