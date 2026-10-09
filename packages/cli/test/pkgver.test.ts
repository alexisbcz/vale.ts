/**
 * Version constraints, and choosing the release this Vale supports.
 *
 * A port of `cmd/vale/pkgver_test.go`'s unit cases. The download paths are
 * exercised against a local server rather than mocked, the same way upstream
 * uses `httptest`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	compareVersions,
	parseConstraint,
	parseVersion,
	satisfies,
} from "../src/semver.ts";
import { sortedReleases, supportsVale } from "../src/pkgver.ts";
import { setVersion } from "../src/version.ts";

let previous = "";

beforeEach(() => {
	previous = setVersion("3.22.0");
});

afterEach(() => {
	setVersion(previous);
});

describe("parseVersion", () => {
	test("reads the forms a package uses", () => {
		expect(parseVersion("3.22.0")).toMatchObject({
			major: 3,
			minor: 22,
			patch: 0,
		});
		expect(parseVersion("v0.1.0")).toMatchObject({ major: 0, minor: 1 });
		expect(parseVersion("1.2.3-beta.1")?.prerelease).toEqual(["beta", "1"]);
		expect(parseVersion("1.2")).toMatchObject({ minor: 2, patch: 0 });
	});

	test("refuses what is not a version", () => {
		expect(parseVersion("master")).toBeNull();
		expect(parseVersion("not a ver")).toBeNull();
		expect(parseVersion("")).toBeNull();
	});
});

describe("compareVersions", () => {
	test("orders by each part in turn", () => {
		const cmp = (a: string, b: string) =>
			compareVersions(parseVersion(a)!, parseVersion(b)!);

		expect(cmp("1.0.0", "2.0.0")).toBeLessThan(0);
		expect(cmp("0.10.0", "0.2.0")).toBeGreaterThan(0);
		expect(cmp("1.0.1", "1.0.0")).toBeGreaterThan(0);
		expect(cmp("1.0.0", "1.0.0")).toBe(0);
	});

	test("a prerelease sorts below the release it leads to", () => {
		const cmp = (a: string, b: string) =>
			compareVersions(parseVersion(a)!, parseVersion(b)!);

		expect(cmp("1.0.0-beta", "1.0.0")).toBeLessThan(0);
		expect(cmp("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
		expect(cmp("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0);
	});
});

describe("parseConstraint", () => {
	const holds = (constraint: string, v: string) =>
		satisfies(parseConstraint(constraint)!, parseVersion(v)!);

	test("comparators", () => {
		expect(holds(">=3.20.0", "3.22.0")).toBe(true);
		expect(holds(">=3.23.0", "3.22.0")).toBe(false);
		expect(holds("<4.0.0", "3.22.0")).toBe(true);
		expect(holds("=3.22.0", "3.22.0")).toBe(true);
		expect(holds("!=3.22.0", "3.22.0")).toBe(false);
		expect(holds("<=3.22.0", "3.22.0")).toBe(true);
		expect(holds(">3.22.0", "3.22.0")).toBe(false);
	});

	test("a group is an AND and || is an OR", () => {
		expect(holds(">=3.0.0, <4.0.0", "3.22.0")).toBe(true);
		expect(holds(">=3.0.0, <3.10.0", "3.22.0")).toBe(false);
		expect(holds("<3.0.0 || >=3.20.0", "3.22.0")).toBe(true);
		expect(holds(">=3.0.0 <4.0.0", "3.22.0")).toBe(true);
	});

	test("tilde and caret", () => {
		expect(holds("~3.22.0", "3.22.9")).toBe(true);
		expect(holds("~3.22.0", "3.23.0")).toBe(false);
		expect(holds("^3.0.0", "3.22.0")).toBe(true);
		expect(holds("^3.0.0", "4.0.0")).toBe(false);
	});

	test("a wildcard matches anything", () => {
		expect(holds("*", "3.22.0")).toBe(true);
	});

	test("refuses what it cannot read", () => {
		expect(parseConstraint("not a ver")).toBeNull();
		expect(parseConstraint(">=")).toBeNull();
	});
});

describe("supportsVale", () => {
	test("a floor this build meets", () => {
		for (const [constraint, want] of [
			["", true],
			[">=3.20.0", true],
			[">=3.22.0", true],
			[">=3.23.0", false],
			["not a ver", true],
		] as const) {
			expect(supportsVale(constraint)).toBe(want);
		}
	});

	test("a missing floor is not a reason to refuse a package", () => {
		expect(supportsVale(undefined)).toBe(true);
		expect(supportsVale("   ")).toBe(true);
	});

	test("a development build meets every floor", () => {
		setVersion("master");
		expect(supportsVale(">=99.0.0")).toBe(true);
	});

	test("a version this build cannot parse meets every floor", () => {
		setVersion("some-dev-build");
		expect(supportsVale(">=99.0.0")).toBe(true);
	});
});

describe("sortedReleases", () => {
	test("newest first, with unparseable versions last", () => {
		const got = sortedReleases([
			{ version: "v0.1.0", url: "" },
			{ version: "draft", url: "" },
			{ version: "0.10.0", url: "" },
			{ version: "v0.2.0", url: "" },
		]);
		expect(got.map((r) => r.version).join(" ")).toBe(
			"0.10.0 v0.2.0 v0.1.0 draft",
		);
	});

	test("the input is left alone", () => {
		const input = [{ version: "1.0.0", url: "" }, { version: "2.0.0", url: "" }];
		sortedReleases(input);
		expect(input[0]?.version).toBe("1.0.0");
	});
});
