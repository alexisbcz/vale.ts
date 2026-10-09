import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	Checker,
	newChecker,
	usingDictionaryByPath,
	usingDictionaryText,
	withDefault,
	withDefaultPath,
} from "../src/index.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "vale-spell-"));
}

// readAsset must keep searching the remaining roots when an earlier root
// neither holds the file nor is a symlink. A regression once made it return
// the readlink error from the first root, so $DICPATH was never consulted.
test("readAsset falls through to later roots", () => {
	const empty = tempDir(); // stands in for StylesPath/config/dictionaries
	const dicpath = tempDir(); // stands in for $DICPATH

	const want = join(dicpath, "en_GB.dic");
	writeFileSync(want, "1\nword\n");

	const m = new Checker({ path: empty, system: dicpath, defaultPath: "" });
	expect(m.readAsset("en_GB.dic")).toBe(want);
});

// A symlinked asset (how Nix typically exposes dictionaries through $DICPATH)
// must be found in its root. A stat follows the link, so readAsset returns
// the link path itself, which the read then follows to the target.
test("readAsset finds a symlinked asset", () => {
	const target = join(tempDir(), "real.dic");
	writeFileSync(target, "1\nword\n");

	const root = tempDir();
	const link = join(root, "en_GB.dic");
	symlinkSync(target, link);

	const m = new Checker({ system: root, path: "", defaultPath: "" });
	expect(m.readAsset("en_GB.dic")).toBe(link);
});

test("readAsset reports where it looked", () => {
	const m = new Checker({ path: tempDir(), system: "", defaultPath: "" });
	expect(() => m.readAsset("nope.dic")).toThrow(/nope\.dic/);
});

// The bundled dictionary uses no directive the reader ignores. A new
// directive appearing here means the reader has fallen behind the dictionary
// it ships with.
test("the built-in dictionary uses no ignored directive", () => {
	expect(newChecker().ignored()).toEqual([]);
});

// The bundled dictionary knows common technical vocabulary, including plurals
// and possessives of acronyms, but still rejects names in the wrong case.
test("the built-in dictionary's technical vocabulary", () => {
	const checker = newChecker();
	const want: Record<string, boolean> = {
		repo: true,
		repos: true,
		"config's": true,
		namespaces: true,
		hostname: true,
		deduplicated: true,
		boolean: true,
		RESTful: true,
		APIs: true,
		"API's": true,
		PRs: true,
		SDKs: true,
		VMs: true,
		Grafana: true,
		Xcode: true,
		walkthroughs: true,

		grafana: false,
		XCode: false,
		github: false,
		Javascript: false,
		yaml: false,
		everytime: false,
		walkthroughes: false,

		// A contraction missing its apostrophe is a typo, not the rare word.
		cant: false,
		wont: false,
		"can't": true,
		"won't": true,
		decanted: true,
		recant: true,
		canted: true,
		wonted: true,

		// Obscure entries one edit from a common word are gone; the common
		// words their flags used to produce are not.
		pervious: false,
		flor: false,
		typw: false,
		relict: false,
		previous: true,
		rather: true,
		bitten: true,
		stricken: true,
		descend: true,
		reduce: true,
		derelict: true,
		redux: true,
		unbidden: true,
		moduli: true,
	};
	for (const [word, ok] of Object.entries(want)) {
		expect(checker.spell(word), word).toBe(ok);
	}
});

test("recase finds the one other-case spelling", () => {
	const checker = newChecker();
	const cases: Record<string, string> = {
		github: "GitHub",
		Github: "GitHub",
		javascript: "JavaScript",
		"github's": "GitHub's",
		kubernetes: "Kubernetes",
		xcode: "Xcode",
	};
	for (const [word, want] of Object.entries(cases)) {
		expect(checker.recase(word), word).toBe(want);
	}
	// A misspelling, not a case difference; or two spellings to choose from.
	for (const word of ["githbu", "javscript", "zorbblat", "https"]) {
		expect(checker.recase(word), word).toBeNull();
	}
});

test("a checker spans several dictionaries", () => {
	const checker = newChecker(
		usingDictionaryText("one", "SET UTF-8\n", "1\nalpha\n"),
		usingDictionaryText("two", "SET UTF-8\n", "1\nbeta\n"),
	);
	expect(checker.size).toBe(2);
	expect(checker.spell("alpha")).toBe(true);
	expect(checker.spell("beta")).toBe(true);
	expect(checker.spell("gamma")).toBe(false);
	// With a dictionary of its own, the built-in one is not loaded.
	expect(checker.spell("namespace")).toBe(false);

	expect(checker.dict(0)).toEqual(new Set(["alpha"]));
	expect(checker.dict(1)).toEqual(new Set(["beta"]));
});

test("withDefault adds the built-in dictionary alongside another", () => {
	const checker = newChecker(
		usingDictionaryText("only", "SET UTF-8\n", "1\nzorbblat\n"),
		withDefault(true),
	);
	expect(checker.size).toBe(2);
	expect(checker.spell("zorbblat")).toBe(true);
	expect(checker.spell("namespace")).toBe(true);
});

test("a dictionary is loaded from its paths and from a folder", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "mini.aff"), "SET UTF-8\nSFX S Y 1\nSFX S 0 s .\n");
	writeFileSync(join(dir, "mini.dic"), "1\nwidget/S\n");

	const byPath = newChecker(
		usingDictionaryByPath(join(dir, "mini.dic"), join(dir, "mini.aff")),
	);
	expect(byPath.spell("widgets")).toBe(true);

	// withDefaultPath loads every .dic in the folder, and the built-in
	// dictionary as well, since no dictionary was named.
	const byFolder = newChecker(withDefaultPath(dir));
	expect(byFolder.spell("widgets")).toBe(true);
	expect(byFolder.spell("namespace")).toBe(true);
});

test("a word list is added to every dictionary", () => {
	const checker = newChecker(
		usingDictionaryText("list", "SET UTF-8\n", "1\nalpha\n"),
	);
	expect(checker.spell("kubectl")).toBe(false);
	checker.addWordList("kubectl\n\n# a comment is a word, except for a bare #\n");
	expect(checker.spell("kubectl")).toBe(true);

	const path = join(tempDir(), "accept.txt");
	writeFileSync(path, "helmfile\n");
	checker.addWordListFile(path);
	expect(checker.spell("helmfile")).toBe(true);
});

test("convert applies every dictionary's ICONV", () => {
	const checker = newChecker(
		usingDictionaryText("iconv", "SET UTF-8\nICONV 1\nICONV ’ '\n", "1\nx\n"),
	);
	expect(checker.convert("don’t")).toBe("don't");
});

test("rank reports a score with each suggestion", () => {
	const checker = newChecker(
		usingDictionaryText("rank", "SET UTF-8\n", "2\nworld\nelephant\n"),
	);
	const ranked = checker.rank("wrold");
	expect(ranked.length).toBeGreaterThan(0);
	expect(ranked[0]?.word).toBe("world");
	expect(ranked[0]?.score).toBeGreaterThan(0);
	// Best first.
	for (let i = 1; i < ranked.length; i++) {
		expect(ranked[i - 1]?.score).toBeGreaterThanOrEqual(ranked[i]?.score as number);
	}
	expect(checker.rank("wrold").length).toBeLessThanOrEqual(6);
});
