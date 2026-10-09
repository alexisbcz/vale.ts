# Porting notes

What was decided, and why, in translating Vale from Go to TypeScript. These are
the things that would otherwise look like mistakes.

## One offset unit

Go counts bytes in some places and runes in others. `regexp2` reports rune
offsets; a string is indexed in bytes; a column is a rune count. Several of
Vale's subtlest functions exist only to convert between them -- `re2Loc`,
`nlp.runeIndex`, `RuneSpanToBytes`, `Block.ByteSpan`.

This port has one unit: the JavaScript string index, a UTF-16 code unit. It is
used wherever Go uses a byte offset into a string, and no conversion happens
anywhere. `Block.byteSpan` survives as a bounds check with a comment saying why
it no longer converts.

Columns are the exception, because a column is a count of characters rather than
of storage. `strLen` returns that count -- code points, so an astral character
occupies one column, as it does under Go's rune count.

The practical consequence: for any text in the Basic Multilingual Plane, every
offset in this port equals the corresponding rune offset in Go. For text outside
it, a surrogate pair is two units here and one rune there, so an internal offset
differs -- but the *reported* line and column still agree, because those are
character counts on both sides.

## Synchronous

Go lints files concurrently, and within a block large enough to be worth it runs
the rules that read nothing but their block concurrently too. This port is
synchronous throughout.

Nothing is lost. The Go comments are explicit that the scheduler must not be
able to change an answer: alerts are added in rule order either way, so which
rule wins a span, and what the masked context holds when a later one is
formatted, do not depend on the order rules happened to finish in. Running them
in order produces exactly what running them concurrently and then collecting
them in order produces.

A caller who wants parallelism lints several files in separate workers, which is
where the parallelism was actually paying off.

The one exception is loading the tree-sitter grammars, which is asynchronous
because WebAssembly instantiation is. `initCode()` does it once, before any
linting; a code file reached before that throws rather than silently skipping.

## Regular expressions

Vale's rules are written for `regexp2` in RE2-compatibility mode -- a port of
.NET's backtracking engine -- and the dialect differs from JavaScript's in ways
that change what a rule matches:

| Construct | `regexp2` with `RE2` | JavaScript | What the port does |
|---|---|---|---|
| `(?i)` mid-pattern | holds to the end of the enclosing group | not supported | rewritten as a `(?i:...)` modifier group over exactly that extent |
| `\b` | Unicode: `\p{L}\p{Mn}\p{Nd}\p{Pc}` and the joiners | ASCII only | a pair of lookarounds over the Unicode set |
| `\s` | RE2's five characters, *excluding* the vertical tab | Unicode whitespace | `[\t\n\f\r ]` |
| `\d`, `\w` | ASCII | ASCII | unchanged |
| `$` | end of the input | end of the input (without `m`) | unchanged |
| `\p{Greek}` | a script | needs `Script=` | translated, with general categories and binary properties passed through |
| `[[:alpha:]]` | ASCII ranges | not supported | expanded |
| `(?>...)` | atomic | not supported | `(?=(X))\k<n>`, which cannot be re-tried |
| `[a-z-[aeiou]]` | .NET subtraction | needs the `v` flag | `[[a-z]--[aeiou]]` |
| group numbering | unnamed groups first, then named | source order | every capturing group is given a synthetic name, so a rule reading group 3 reads the same text |

`\b` is the one with a cost: a pair of lookarounds is slower than the engine's
own boundary. The literal prefilter -- which rules a pattern out before the
engine sees it, and which this port reimplements over its own parse tree --
removes almost all of that, because almost every rule is asked about text it
cannot match.

A pattern the translator cannot read is a `PatternError` naming the pattern,
which surfaces as the `E201` a style author expects.

## What the dependencies became

| Go | Here | Note |
|---|---|---|
| `errata-ai/ini` | `core/ini.ts` | written out; the shadow mechanism is what the configuration pipeline is built on |
| `gobwas/glob` + `doublestar` | `core/glob.ts` | both dialects, because Vale picks between them by whether the pattern holds `**`, and the difference is visible to users |
| `jdkato/regexp2` | `@vale-ts/regex` | see above |
| `jdkato/prose` | `@vale-ts/nlp` | the tagger and segmenter read `prose`'s own trained models, byte for byte |
| `neurosnap/sentences` | `@vale-ts/nlp` | the Punkt engine, with `prose`'s customizations |
| `gospell` | `@vale-ts/spell` | Hunspell affix expansion, lookup and suggestions |
| `d5/tengo` | `@vale-ts/tengo` | a tree-walking interpreter for the subset `script` rules, `metric` formulas and `suggest` actions use |
| `expr-lang/expr` | `core/expr.ts` | the subset a conditional section and `--filter` expose |
| `yuin/goldmark` | `markdown-it` | CommonMark with the GitHub extensions, plus the `$…$` math rules Vale adds |
| `x/net/html` tokenizer | `lint/tokenizer.ts` | written out, because the walker depends on its exact token shape |
| `cascadia` + `x/net/html` tree | `parse5` + `css-select` | only for `doc(...)` selectors, which need a tree |
| `tomwright/dasel` | `core/dasel.ts` | a documented subset: the constructs Vale's own views use, read one step at a time so that a failure is reported where dasel reports it |
| `go-tree-sitter` + grammars | `web-tree-sitter` + `tree-sitter-wasms` | the same grammars, compiled to wasm; six languages fall back to a scanner, below |
| `textfsm` | `core/textfsm.ts` | ported |
| `go-org` | `lint/org.ts` | written out; what it covers is documented in the file |
| `pterm`, `tablewriter` | `cli/` | the few ANSI sequences and the column fitting, written out |
| `Masterminds/sprig`, `text/template` | `cli/` | the subset Vale's own output templates use, documented there |

Three Go dependencies are deliberately *not* reproduced: the HTTP NLP endpoint
(`NLPEndpoint` throws a clear error rather than making requests), profiling, and
the Windows-specific console handling.

## Where this port and Vale can still differ

Known and accepted:

- **Markdown conversion.** `goldmark` and `markdown-it` are both CommonMark, and
  agree on the structure of a document; they differ in the HTML they emit for a
  few constructs -- an attribute's order, a task list's markup. The walker reads
  text and tags, so most differences are invisible, but a rule scoped to a class
  that only one of them emits would see different text.

  One of these was not invisible and is fixed: markdown-it prettifies a
  linkified URL's visible text, decoding its percent-escapes and its punycode,
  and goldmark leaves it as written. The walker keeps a URL out of the prose by
  recognizing that a link's text *is* its `href`, so a prettified text meant
  every word inside such a URL was linted. `normalizeLinkText` is the identity
  here. A bare non-ASCII *domain* is still a difference, because the `href` is
  punycoded on this side only; nothing in Vale's corpus or in the style
  packages has one.
- **External converters.** reStructuredText, AsciiDoc, DITA and Typst are
  converted by the same programs Vale calls, so the two agree exactly -- as long
  as the same versions are installed. The compatibility suite's `--self-check`
  mode exists to separate that from a difference in the port.
- **Case mapping.** JavaScript does full Unicode case mapping where Go does
  simple per-character mapping. They differ for a handful of characters (`ß`,
  `İ`, final sigma, the ligatures). `@vale-ts/spell` reimplements the simple
  mapping, because Hunspell's `CHECKSHARPS` and Turkic handling depend on it;
  elsewhere the difference is accepted.
- **Six languages read their comments with a scanner, not a grammar.**
  `tree-sitter-wasms` is pinned to a build that `web-tree-sitter` 0.26 and later
  refuse, and inside the version that accepts it the `yaml`, `elm` and `ql`
  modules are unusable -- `yaml` breaks the runtime for every file parsed after
  it. So YAML, Haskell, Julia, Protobuf, Clojure and PowerShell are read by a
  delimiter scanner in `lint/code/scanner.ts`. It produces the same `Comment`
  shape, so dedenting, markup inside comments and alert placement are
  identical; what it cannot do is run a view's tree-sitter *queries*, because
  there is no tree to query.
- **Map iteration order.** Go randomizes it, and a few places in Vale iterate a
  map where the order is not quite irrelevant. This port iterates in insertion
  order, which is deterministic -- so where Go's output varies between runs, this
  port picks one of the answers Go might give and keeps picking it.

Anything else is a bug. The compatibility suite is how to find out which.
