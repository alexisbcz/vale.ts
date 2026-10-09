import { describe, expect, test } from "bun:test";
import { quoteMeta, Regexp, Required, translate } from "../src/index.ts";

/** The matched text of every match, which is what most assertions need. */
function all(pattern: string, subject: string): string[] {
	return Regexp.compile(pattern).findAllString(subject);
}

describe("inline flag directives", () => {
	test("a leading directive becomes a real flag", () => {
		const re = Regexp.compile("(?i)abc");
		expect(re.jsFlags).toContain("i");
		expect(re.jsSource).toBe("abc");
		expect(all("(?i)abc", "ABC")).toEqual(["ABC"]);
	});

	test("several leading directives all hoist", () => {
		const re = Regexp.compile("(?i)(?m)(?s)a.b");
		expect(re.jsFlags).toContain("i");
		expect(re.jsFlags).toContain("m");
		expect(re.jsFlags).toContain("s");
	});

	test("a directive applies to the rest of its sequence", () => {
		expect(all("a(?i)b", "aB")).toEqual(["aB"]);
		expect(all("a(?i)b", "Ab")).toEqual([]);
	});

	test("a directive reaches the branches after it", () => {
		// .NET scopes an inline option to the enclosing group, and an
		// alternation is not one -- so `(?i)` in one branch covers the next.
		expect(all("(?:(?i)abc|def)", "DEF")).toEqual(["DEF"]);
		expect(all("x(?i)a|b", "xA B")).toEqual(["xA", "B"]);
	});

	test("a directive stops at the end of its group", () => {
		expect(all("(?:(?i)a)b", "AB")).toEqual([]);
		expect(all("(?:(?i)a)b", "Ab")).toEqual(["Ab"]);
	});

	test("clearing undoes an outer directive", () => {
		expect(all("(?i)a(?-i)b", "Ab")).toEqual(["Ab"]);
		expect(all("(?i)a(?-i)b", "AB")).toEqual([]);
	});

	test("`(?-i)` per term keeps an alternation case-sensitive", () => {
		// What `updateExceptions` builds for a rule's exceptions.
		const pattern = String.raw`(?i)(?m)\b(?:(?-i)Foo|bar)\b`;
		expect(all(pattern, "foo Foo BAR bar")).toEqual(["Foo", "bar"]);
	});

	test("a scoped group is kept scoped", () => {
		expect(all("(?i:a)b", "Ab")).toEqual(["Ab"]);
		expect(all("(?i:a)b", "AB")).toEqual([]);
	});
});

describe("character classes", () => {
	test("`\\s` is RE2's, which excludes the vertical tab", () => {
		expect(all(String.raw`\s`, "\u000b")).toEqual([]);
		expect(all(String.raw`\s`, "\t")).toEqual(["\t"]);
		expect(all(String.raw`\s`, " ")).toEqual([]);
	});

	test("`\\S` is its complement", () => {
		expect(all(String.raw`\S+`, "a b")).toEqual(["a b"]);
	});

	test("`\\d` and `\\w` are ASCII", () => {
		expect(all(String.raw`\d+`, "١٢٣")).toEqual([]);
		expect(all(String.raw`\w+`, "é")).toEqual([]);
	});

	test("POSIX bracket expressions expand to ASCII ranges", () => {
		expect(all("[[:alpha:]]+", "abcé")).toEqual(["abc"]);
		expect(all("[[:digit:][:alpha:]]+", "a1-")).toEqual(["a1"]);
	});

	test("Go's script names become JavaScript's", () => {
		expect(all(String.raw`\p{Greek}+`, "abαβγ")).toEqual(["αβγ"]);
		expect(all(String.raw`\pL+`, "ab1")).toEqual(["ab"]);
		expect(all(String.raw`\p{Lu}+`, "aBC")).toEqual(["BC"]);
	});

	test(".NET class subtraction works", () => {
		expect(all("[a-z-[aeiou]]+", "hello")).toEqual(["h", "ll"]);
	});

	test("a `]` in first position is a literal", () => {
		expect(all("[]a]+", "]a]b")).toEqual(["]a]"]);
	});

	test("a trailing `-` is a literal", () => {
		expect(all("[a-]+", "a-b")).toEqual(["a-"]);
	});
});

describe("word boundaries", () => {
	test("`\\b` is Unicode-aware, as .NET's is", () => {
		// JavaScript's own `\b` would match here, because it reads `é` as a
		// non-word character; .NET's does not.
		expect(all(String.raw`\bfoo\b`, "fooé")).toEqual([]);
		expect(all(String.raw`\bfoo\b`, "foo!")).toEqual(["foo"]);
		expect(all(String.raw`\bété\b`, "une été ici")).toEqual(["été"]);
	});

	test("`\\B` is its complement", () => {
		expect(all(String.raw`\Boo`, "foo")).toEqual(["oo"]);
	});

	test("`\\b` inside a class is a backspace", () => {
		expect(all("[\\b]", "\u0008")).toEqual(["\u0008"]);
	});
});

describe("anchors", () => {
	test("`$` is the end of the input, as in RE2", () => {
		expect(all("a$", "a\n")).toEqual([]);
		expect(all("(?m)a$", "a\nb")).toEqual(["a"]);
	});

	test("`\\A` and `\\z` ignore the multiline flag", () => {
		expect(all(String.raw`(?m)\Aa`, "b\na")).toEqual([]);
		expect(all(String.raw`(?m)a\z`, "a\nb")).toEqual([]);
	});
});

describe("groups", () => {
	test("`(?P<name>...)` is accepted", () => {
		const re = Regexp.compile("(?P<word>a+)");
		expect(re.subexpNames()).toEqual(["", "word"]);
		expect(re.findAllStringSubmatch("aa")).toEqual([["aa", "aa"]]);
	});

	test("unnamed groups are numbered before named ones", () => {
		// .NET's numbering, which the `existence` check's group mapping needs.
		const re = Regexp.compile("(?<first>a)(b)");
		expect(re.subexpNames()).toEqual(["", "", "first"]);
		const m = re.find("ab");
		expect(m?.groups).toEqual(["ab", "b", "a"]);
	});

	test("a backreference resolves through the renumbering", () => {
		// `(b)` is group 1 and `x` is group 2, so `\2` is the `a`.
		expect(all(String.raw`(?<x>a)(b)\2`, "aba")).toEqual(["aba"]);
		expect(all(String.raw`(?<x>a)(b)\1`, "abb")).toEqual(["abb"]);
		expect(all(String.raw`(?<x>a)(b)\k<x>`, "aba")).toEqual(["aba"]);
		expect(all(String.raw`(?P<x>a)(?P=x)`, "aa")).toEqual(["aa"]);
	});

	test("an atomic group does not give back its match", () => {
		expect(all("(?>a+)b", "aaab")).toEqual(["aaab"]);
		expect(all("(?>a+)a", "aaa")).toEqual([]);
	});

	test("a comment group disappears", () => {
		expect(all("a(?#why)b", "ab")).toEqual(["ab"]);
	});
});

describe("quantifiers", () => {
	test("a brace that is not a quantifier is a literal", () => {
		expect(all("a{,2}", "a{,2}")).toEqual(["a{,2}"]);
		expect(all("a{}", "a{}")).toEqual(["a{}"]);
	});

	test("a quantifier binds to the last character of a literal run", () => {
		expect(all("abc+", "abccc")).toEqual(["abccc"]);
		expect(all("abc+", "abcabc")).toEqual(["abc", "abc"]);
	});

	test("a possessive quantifier does not give back", () => {
		expect(all("a++b", "aab")).toEqual(["aab"]);
		expect(all("a++a", "aaa")).toEqual([]);
	});
});

describe("characters the dialect allows and JavaScript does not", () => {
	test("an unescaped `]` or `}` is a literal", () => {
		expect(all("foo]bar", "foo]bar")).toEqual(["foo]bar"]);
		expect(all("foo}bar", "foo}bar")).toEqual(["foo}bar"]);
	});

	test("escapes JavaScript rejects in `u` mode pass through", () => {
		expect(all(String.raw`a\-b`, "a-b")).toEqual(["a-b"]);
		expect(all(String.raw`\x{1F600}`, "\u{1F600}")).toEqual(["\u{1F600}"]);
	});
});

describe("offsets", () => {
	test("spans are string indices", () => {
		const re = Regexp.compile("b+");
		expect(re.findAllStringIndex("abba")).toEqual([[1, 3]]);
	});

	test("a group that did not take part reports -1", () => {
		const re = Regexp.compile("(a)|(b)");
		expect(re.findAllStringSubmatchIndex("b")).toEqual([[0, 1, -1, -1, 0, 1]]);
	});

	test("a zero-length match advances by one character", () => {
		const re = Regexp.compile("x*");
		expect(re.findAllStringIndex("ab")).toEqual([
			[0, 0],
			[1, 1],
			[2, 2],
		]);
	});
});

describe("replace", () => {
	test("`$1` refers to a group in .NET's numbering", () => {
		const re = Regexp.compile("(?<named>a)(b)");
		expect(re.replace("ab", "$1-$2")).toBe("b-a");
		expect(re.replace("ab", "${named}")).toBe("a");
	});

	test("`$$` is a literal dollar", () => {
		expect(Regexp.compile("a").replace("a", "$$")).toBe("$");
	});

	test("count and start bound the work", () => {
		const re = Regexp.compile("a");
		expect(re.replace("aaa", "b", -1, 2)).toBe("bba");
		expect(re.replace("aaa", "b", 1, -1)).toBe("abb");
	});
});

describe("split", () => {
	test("pieces fall between the matches", () => {
		expect(Regexp.compile(",").split("a,b,c")).toEqual(["a", "b", "c"]);
		expect(Regexp.compile(",").split("a,b,c", 2)).toEqual(["a", "b,c"]);
		expect(Regexp.compile("x").split("abc")).toEqual(["abc"]);
	});

	test("a lookbehind keeps an escaped delimiter", () => {
		// How `getOptions` separates a substitution's suggestions.
		const re = Regexp.compile(String.raw`(?<!\\)\|`);
		expect(re.split(String.raw`a\|b|c`)).toEqual([String.raw`a\|b`, "c"]);
	});
});

describe("prefilter", () => {
	test("a literal is required", () => {
		expect(Required("(?i)colour")).toEqual(["colour"]);
	});

	test("every branch of an alternation must supply one", () => {
		expect(Required("(?:foo|bar)")).toEqual(["foo", "bar"]);
		expect(Required("(?:foo|.)")).toEqual([]);
	});

	test("the longest requirement of a sequence wins", () => {
		expect(Required("ab+cdef")).toEqual(["cdef"]);
	});

	test("an optional part requires nothing", () => {
		expect(Required("(?:foo)?")).toEqual([]);
		expect(Required("x*")).toEqual([]);
	});

	test("a single character is not worth filtering on", () => {
		expect(Required("a")).toEqual([]);
	});

	test("a lookaround contributes nothing but blocks nothing", () => {
		expect(Required("(?=x)abcd")).toEqual(["abcd"]);
	});

	test("the filter admits anything the pattern can match", () => {
		const re = Regexp.compile(String.raw`(?i)\b(?:utilize)\b`);
		expect(re.mightMatch("we utilize it")).toBe(true);
		expect(re.mightMatch("we UTILIZE it".toLowerCase())).toBe(true);
		expect(re.mightMatch("nothing here")).toBe(false);
	});
});

describe("errors", () => {
	test("an unbalanced group is rejected", () => {
		expect(() => Regexp.compile("(a")).toThrow();
		expect(() => Regexp.compile("a)")).toThrow();
	});

	test("an unknown Unicode class is rejected", () => {
		expect(() => Regexp.compile(String.raw`\p{NotAThing}`)).toThrow();
	});

	test("a dangling quantifier is rejected", () => {
		expect(() => Regexp.compile("*a")).toThrow();
	});

	test("the same pattern fails the same way twice", () => {
		// Translations are cached, errors included.
		expect(() => Regexp.compile("(")).toThrow();
		expect(() => Regexp.compile("(")).toThrow();
	});
});

describe("quoteMeta", () => {
	test("escapes what has a special meaning", () => {
		expect(quoteMeta("a.b*c")).toBe(String.raw`a\.b\*c`);
		expect(all(quoteMeta("a.b"), "a.b axb")).toEqual(["a.b"]);
	});
});

describe("translate", () => {
	test("reports the pattern it was given", () => {
		expect(translate("(?i)a").pattern).toBe("(?i)a");
	});

	test("an empty pattern matches everywhere", () => {
		expect(Regexp.compile("").findAllStringIndex("ab")).toEqual([
			[0, 0],
			[1, 1],
			[2, 2],
		]);
	});
});
