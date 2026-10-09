import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Info,
	registerModel,
	resetModels,
	TokenCache,
	taggerFor,
	tagText,
	tagTextWith,
	textToTokens,
	textToTokensWith,
} from "../src/info.ts";
import { tokenIn } from "../src/words.ts";

const remote: Info = { endpoint: "http://localhost:9999", lang: "ja" };
const local: Info = { endpoint: "", lang: "en" };

afterEach(() => {
	resetModels();
});

describe("tagText", () => {
	test("tags across sentence boundaries with offsets into the whole text", () => {
		const src = "Hello World. My name is Jonas.";
		const toks = tagText(src);
		expect(toks.map((t) => t.text)).toEqual([
			"Hello",
			"World",
			".",
			"My",
			"name",
			"is",
			"Jonas",
			".",
		]);
		for (const tok of toks) {
			expect(tokenIn(src, tok)).toBe(tok.text);
			expect(tok.tag).not.toBe("");
		}
	});

	test("offsets survive leading whitespace and multi-byte text", () => {
		const src = "  “Naïve café,” he said. Then he left.";
		for (const tok of tagText(src)) {
			expect(tokenIn(src, tok)).toBe(tok.text);
		}
	});

	test("tags each sentence on its own", () => {
		// The tagger conditions on the previous two tags, so a boundary has to
		// reset that context rather than carrying it across.
		const alone = tagText("Hello World.");
		const together = tagText("Hello World. My name is Jonas.").slice(0, 3);
		expect(together.map((t) => t.tag)).toEqual(alone.map((t) => t.tag));
	});

	test("an empty text yields no tokens", () => {
		expect(tagText("")).toEqual([]);
	});
});

describe("textToTokens", () => {
	test("falls back to the built-in tagger with no info", () => {
		expect(textToTokens("Hello World.").length).toBe(3);
		expect(textToTokens("Hello World.", null).length).toBe(3);
		expect(textToTokens("Hello World.", local).length).toBe(3);
	});

	test("a remote endpoint is an error, not a silent fallback", () => {
		expect(() => textToTokens("Hello.", remote)).toThrow("not supported");
		expect(() => textToTokensWith("", "Hello.", remote)).toThrow("not supported");
	});
});

describe("taggerFor", () => {
	test("an empty name gives the shared default", () => {
		expect(taggerFor("")).toBe(taggerFor(""));
		expect(taggerFor("").name()).toBe("perceptron");
	});

	test("an unknown name is an error rather than a quiet fallback", () => {
		// A rule written against one tagger reads differently under another, so
		// substituting one would change what the rule means.
		expect(() => taggerFor("nope")).toThrow("no tagger model named");
	});

	test("a registered dictionary becomes a lexical tagger", () => {
		const dir = mkdtempSync(join(tmpdir(), "vale-nlp-"));
		const path = join(dir, "model.dic");
		writeFileSync(path, "aware\tJJ\n");

		registerModel("mine", path);
		const t = taggerFor("mine");
		expect(t.name()).toBe("lexical");

		const toks = tagTextWith("mine", "They were all ready aware of it.");
		expect(toks.find((x) => x.text === "aware")?.tag).toBe("JJ");

		// Registering the same name twice is a no-op, as in Go.
		registerModel("mine", join(dir, "missing.dic"));
		expect(taggerFor("mine")).toBe(t);
	});
});

describe("TokenCache", () => {
	test("tags a text once and shares the result", () => {
		const cache = new TokenCache();
		const first = cache.tokens("Hello World.", local);
		expect(cache.tokens("Hello World.", local)).toBe(first);
	});

	test("keys by model as well as by text", () => {
		const dir = mkdtempSync(join(tmpdir(), "vale-nlp-"));
		const path = join(dir, "model.dic");
		writeFileSync(path, "world\tJJ\n");
		registerModel("mine", path);

		const cache = new TokenCache();
		const plain = cache.tokens("Hello World.", local);
		const mine = cache.tokensWith("mine", "Hello World.", local);
		expect(mine).not.toBe(plain);
		expect(mine.find((t) => t.text === "World")?.tag).toBe("JJ");
		expect(plain.find((t) => t.text === "World")?.tag).not.toBe("JJ");
	});

	test("different texts are cached apart", () => {
		const cache = new TokenCache();
		expect(cache.tokens("One.", local)).not.toBe(cache.tokens("Two.", local));
	});
});
