import { describe, expect, test } from "bun:test";
import {
	DEFAULT,
	englishModel,
	isEmoticon,
	Lexical,
	names,
	newTagger,
	normalize,
	open,
	prefix1,
	readDictionary,
	suffix,
	unmarshal,
} from "../src/tag/index.ts";
import { newToken, type Token } from "../src/token.ts";
import { proseTokenizer, tokenIn } from "../src/words.ts";

const tagOf = (tokens: Token[], word: string): string | undefined =>
	tokens.find((t) => t.text === word)?.tag;

const tagged = (sentence: string): string =>
	newTagger()
		.tag(sentence.split(" "))
		.map((t) => t.tag)
		.join(" ");

describe("Tagger", () => {
	/**
	 * Specific taggings that are not in doubt.
	 *
	 * The full cross-check against the Go binary happens in the repo's
	 * compatibility suite; what is pinned here is the handful of answers that
	 * are obviously right, so a port that loads the model but reads its
	 * features wrong fails immediately rather than quietly tagging worse.
	 */
	test("tags sentences the way Penn would", () => {
		expect(tagged("The quick brown fox jumps over the lazy dog .")).toBe(
			"DT JJ NN NN VBZ IN DT JJ NN .",
		);
		expect(tagged("The cat sat on the mat .")).toBe("DT NN VBD IN DT NN .");
		expect(tagged("She sells seashells by the seashore .")).toBe(
			"PRP VBZ NNS IN DT NN .",
		);
		expect(tagged("I can not do this .")).toBe("PRP MD RB VB DT .");
		expect(tagged("Go is an open source programming language .")).toBe(
			"NN VBZ DT JJ NN NN NN .",
		);
	});

	test("agrees with prose about the words prose's own tests name", () => {
		// `tag/lexicon_test.go` and `tag/lexical_test.go` both assert these
		// answers, so they are a direct cross-check against the Go tagger.
		const t = newTagger();
		expect(
			tagOf(t.tag(["They", "were", "all", "ready", "aware", "of", "it"]), "aware"),
		).toBe("NN");
		expect(tagOf(t.tag(["I", "like", "it"]), "like")).toBe("VBP");
	});

	test("short-circuits the model for tokens it never saw", () => {
		const t = newTagger();
		expect(tagOf(t.tag(["a", "-", "b"]), "-")).toBe("-");
		expect(tagOf(t.tag(["hi", ":-)"]), ":-)")).toBe("SYM");
		expect(tagOf(t.tag(["ask", "@jane"]), "@jane")).toBe("NN");
		expect(tagOf(t.tag(["*-1"]), "*-1")).toBe("-NONE-");
		expect(tagOf(t.tag(["-LRB-"]), "-LRB-")).toBe("-LRB-");
	});

	test("tags every token it is handed", () => {
		for (const tok of newTagger().tag("The cat sat on the mat .".split(" "))) {
			expect(tok.tag).not.toBe("");
		}
	});

	test("leaves an empty input alone", () => {
		const empty: Token[] = [];
		newTagger().tagTokens(empty);
		expect(empty).toEqual([]);
	});

	test("reports its name", () => {
		expect(newTagger().name()).toBe(DEFAULT);
	});

	describe("a lexicon", () => {
		const words = ["They", "were", "all", "ready", "aware", "of", "it"];

		test("overrides the model's reading", () => {
			const fixed = newTagger(new Map([["aware", "JJ"]]));
			expect(tagOf(fixed.tag(words), "aware")).toBe("JJ");
		});

		test("covers every casing from one entry", () => {
			const t = newTagger(new Map([["available", "JJ"]]));
			for (const w of ["available", "Available", "AVAILABLE"]) {
				expect(tagOf(t.tag(["data", "is", w, "now"]), w)).toBe("JJ");
			}
		});

		test("prefers an exact-case entry over the folded one", () => {
			const t = newTagger(
				new Map([
					["us", "PRP"],
					["US", "NNP"],
				]),
			);
			expect(tagOf(t.tag(["send", "US", "mail"]), "US")).toBe("NNP");
			expect(tagOf(t.tag(["send", "us", "mail"]), "us")).toBe("PRP");
		});

		test("changes nothing when it is empty", () => {
			const plain = newTagger();
			const withNone = newTagger(new Map());
			expect(withNone.tag(words).map((t) => t.tag)).toEqual(
				plain.tag(words).map((t) => t.tag),
			);
		});
	});

	test("leaves a token's position untouched", () => {
		// Positions originate in the tokenizer and are only useful if they
		// survive everything downstream.
		const src =
			"He said “hi there” to me. They'll save $100 (roughly), " +
			"but Dr. Smith won't — it’s 50% off!";
		const toks = proseTokenizer().tokenize(src);
		const before = toks.map((t) => ({ ...t }));

		newTagger().tagTokens(toks);

		for (let i = 0; i < toks.length; i++) {
			expect(toks[i]!.start).toBe(before[i]!.start);
			expect(toks[i]!.text).toBe(before[i]!.text);
			expect(tokenIn(src, toks[i]!)).toBe(toks[i]!.text);
			expect(toks[i]!.tag).not.toBe("");
		}
	});
});

describe("the flat model", () => {
	test("decodes the shipped English model", () => {
		const m = englishModel();
		expect(m.classes.length).toBe(45);
		expect(m.numFeatures()).toBe(75447);
		expect(m.numPairs()).toBe(271206);
		expect(m.classes).toContain("NN");
		expect(m.classes).toContain("VBZ");
	});

	test("is decoded once and shared", () => {
		expect(englishModel()).toBe(englishModel());
	});

	test("answers for the words it is sure about", () => {
		const m = englishModel();
		expect(m.tagFor("The")).toBe("DT");
		expect(m.tagFor("is")).toBe("VBZ");
		// A word with more than one reading is left to scoring.
		expect(m.tagFor("brown")).toBeUndefined();
	});

	test("finds a feature by its UTF-8 bytes", () => {
		const m = englishModel();
		const bytes = (s: string) => new TextEncoder().encode(s);
		expect(m.feature(bytes("bias"))).toBeGreaterThanOrEqual(0);
		expect(m.feature(bytes("i word the"))).toBeGreaterThanOrEqual(0);
		expect(m.feature(bytes("no such feature at all"))).toBe(-1);
	});

	test("accumulates only for a known feature", () => {
		const m = englishModel();
		const scores = new Float32Array(m.classes.length);
		expect(m.accumulateInto(new TextEncoder().encode("bias"), 1, scores)).toBe(
			true,
		);
		expect(scores.some((v) => v !== 0)).toBe(true);
		expect(m.accumulateInto(new TextEncoder().encode("nope nope"), 1, scores)).toBe(
			false,
		);
	});

	test("breaks a tie toward the lowest class ID", () => {
		const m = englishModel();
		const scores = new Float32Array(m.classes.length);
		expect(m.best(scores)).toBe(m.classes[0]);
	});

	test("rejects bytes that are not a model", () => {
		expect(() => unmarshal(new Uint8Array(32))).toThrow(
			"not a prose flat tagger model",
		);
	});
});

describe("the byte-oriented feature pieces", () => {
	const enc = new TextEncoder();

	test("suffix takes the last three bytes, not the last three characters", () => {
		// `café` is five bytes, so its trained suffix cuts through the
		// two-byte `é` -- which is the point: the model was built that way.
		expect([...suffix(enc.encode("café"), 3)]).toEqual([0x66, 0xc3, 0xa9]);
		expect([...suffix(enc.encode("ab"), 3)]).toEqual([...enc.encode("ab")]);
	});

	test("prefix1 takes the first byte", () => {
		expect([...prefix1(enc.encode("école"))]).toEqual([0xc3]);
		expect([...prefix1(new Uint8Array(0))]).toEqual([]);
	});

	test("normalize folds the forms the model was trained on", () => {
		expect(normalize("")).toBe("");
		expect(normalize("matter-of-fact")).toBe("!HYPHEN");
		// A leading hyphen is not the hyphen rule's business: that one is for an
		// infix. `-5` is two bytes, so it is not a year either.
		expect(normalize("-5")).toBe("-5");
		expect(normalize("5-")).toBe("!HYPHEN");
		expect(normalize("5000")).toBe("!YEAR");
		expect(normalize("1999")).toBe("!YEAR");
		expect(normalize("-999")).toBe("!YEAR");
		expect(normalize("12345")).toBe("!DIGITS");
		expect(normalize("Hello")).toBe("hello");
		expect(normalize("cafÉ")).toBe("café");
	});
});

describe("Lexical", () => {
	const lexical = (dict: string) => new Lexical(readDictionary(dict), newTagger());

	test("overrides context for a word it is sure about", () => {
		const words = ["They", "were", "all", "ready", "aware", "of", "it"];
		expect(tagOf(lexical("aware\tJJ\n").tag(words), "aware")).toBe("JJ");
	});

	test("leaves an ambiguous word to context", () => {
		const lex = lexical("code\tNN\tVB\n");
		for (const got of [
			tagOf(lex.tag(["the", "code", "is", "broken"]), "code"),
			tagOf(lex.tag(["they", "code", "every", "day"]), "code"),
		]) {
			expect(got).toBeDefined();
			expect(["NN", "VB"]).toContain(got as string);
		}
	});

	test("refines within the class the model chose", () => {
		// The model reads `like` as `VBP`, which the dictionary does not list;
		// `VB` is the listed tag of the same class, and noun is not.
		expect(
			tagOf(lexical("like\tNN\tVB\tJJ\tIN\n").tag(["I", "like", "it"]), "like"),
		).toBe("VB");
	});

	test("defers on words it does not know", () => {
		const words = ["the", "quick", "brown", "fox"];
		const want = newTagger().tag(words);
		const got = lexical("aware\tJJ\n").tag(words);
		expect(got.map((t) => t.tag)).toEqual(want.map((t) => t.tag));
	});

	test("covers every casing from one entry", () => {
		const lex = lexical("aware\tJJ\n");
		for (const w of ["aware", "Aware", "AWARE"]) {
			expect(tagOf(lex.tag(["is", w, "here"]), w)).toBe("JJ");
		}
	});

	test("writes into the caller's tokens", () => {
		const toks = [newToken("aware", 0)];
		lexical("aware\tJJ\n").tagTokens(toks);
		expect(toks[0]!.tag).toBe("JJ");
	});

	test("reports its name", () => {
		expect(lexical("aware\tJJ\n").name()).toBe("lexical");
	});

	test("needs a dictionary", () => {
		expect(() => new Lexical(new Map(), newTagger())).toThrow("needs a dictionary");
	});
});

describe("readDictionary", () => {
	test("reads one word per line, tab-separated", () => {
		const entries = readDictionary("# a comment\n\naware\tJJ\ncode\tNN\tVB\n");
		expect(entries.get("aware")).toEqual(["JJ"]);
		expect(entries.get("code")).toEqual(["NN", "VB"]);
		expect(entries.size).toBe(2);
	});

	test("rejects a line with no tag", () => {
		expect(() => readDictionary("aware\n")).toThrow("at least one tag");
	});

	test("reads a CRLF file the same way", () => {
		expect(readDictionary("aware\tJJ\r\n").get("aware")).toEqual(["JJ"]);
	});
});

describe("the registry", () => {
	test("an empty name gives the default", () => {
		expect(open("").name()).toBe(DEFAULT);
		expect(names()).toContain(DEFAULT);
	});

	test("an unknown name is an error", () => {
		expect(() => open("nope")).toThrow("no tagger named");
	});
});

describe("emoticons", () => {
	test("are shared by the tokenizer and the tagger", () => {
		expect(isEmoticon(":-)")).toBe(true);
		expect(isEmoticon("¯\\(ツ)/¯")).toBe(true);
		expect(isEmoticon("hello")).toBe(false);
	});
});
