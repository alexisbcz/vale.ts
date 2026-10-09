# vale.ts

[Vale](https://vale.sh), the syntax-aware prose linter, ported from Go to
TypeScript. Importable as a library, runnable as a CLI, and checked against
Vale's own end-to-end suite so that "compatible" is a number rather than a
claim.

```ts
import { lint } from "vale-ts";

const alerts = await lint("docs/guide.md");
for (const a of alerts) {
  console.log(`${a.path}:${a.line}:${a.span[0]}:${a.check}:${a.message}`);
}
```

```console
$ bunx @vale-ts/cli docs/
 docs/guide.md
 12:5   warning  'utilize' is wordy.  Microsoft.Wordiness
 31:1   error    Did you mean 'the'?  Vale.Spelling
```

## Why a port rather than a binding

Vale is a 32,000-line Go program whose hardest problem is not finding a match
but *placing* one: a rule reports a span within a paragraph that a Markdown
converter rewrote, and the user needs a line and a column in the file they
wrote. Wrapping the binary gives you that logic and nothing else. Porting it
gives you the model it is built on — configuration, scopes, blocks, rules — so
that a TypeScript program can hold a `File`, add a rule, swap a reader, or lint
a string it never wrote to disk.

The port is faithful rather than inspired. Where the Go code carries a comment
explaining why a heuristic exists, that reasoning is carried over too, because
it is the part that took years to learn.

## Status

| | |
|---|---|
| Rule types | `existence`, `substitution`, `occurrence`, `repetition`, `consistency`, `capitalization`, `conditional`, `readability`, `spelling`, `sequence`, `metric`, `script` |
| Formats read natively | Markdown, MDX, MyST, Quarto, HTML, XML, Org, QDoc, plain text, Jupyter, JSON/YAML/TOML, source comments for 20+ languages |
| Formats needing a converter | reStructuredText (Docutils), AsciiDoc (Asciidoctor), DITA (DITA-OT), Typst (`typst2vast`) — the same tools Vale itself shells out to |
| Compatibility | run `bun run test:compat -- --reference` for the current number |

Run the compatibility suite to see exactly where this port and Vale disagree;
see [Compatibility](#compatibility) below.

## Install

```console
bun add vale-ts            # the library
bun add -g @vale-ts/cli    # the `vale-ts` command
```

Bun 1.2 or later. The engine itself is runtime-agnostic TypeScript; the CLI and
the filesystem layer use `node:` built-ins, so Node 22+ works too.

## Using it as a library

```ts
import { Vale } from "vale-ts";

// Reads `.vale.ini` the way the CLI does: the project's, then the user's.
const vale = await Vale.fromConfig();

// Lint a file, or a string with a path to decide which rules apply.
const files = vale.lintFile("docs/guide.md");
const stdin = vale.lintString("Some prose to check.", { path: "note.md" });

for (const file of files) {
  for (const alert of file.sortedAlerts()) {
    console.log(alert.check, alert.message, alert.severity);
  }
}
```

A configuration can also be built in memory, which is what a language server or
a CI check usually wants:

```ts
const vale = await Vale.fromString(`
StylesPath = styles
MinAlertLevel = warning

[*.md]
BasedOnStyles = Vale
`);
```

### The packages

The monorepo publishes one package per layer, so a caller can take the piece it
needs and leave the rest. Each is independently useful.

| Package | What it is |
|---|---|
| [`vale-ts`](packages/vale) | the facade: `Vale`, `lint`, and the types |
| [`@vale-ts/cli`](packages/cli) | the `vale-ts` command |
| [`@vale-ts/core`](packages/core) | configuration, alerts, the file model, and the arithmetic that turns a match into a line and a column |
| [`@vale-ts/check`](packages/check) | the rule types and the scope selectors they run in |
| [`@vale-ts/lint`](packages/lint) | the readers that turn a document into blocks |
| [`@vale-ts/nlp`](packages/nlp) | tokenizers, a Punkt sentence segmenter, an averaged-perceptron POS tagger, readability metrics |
| [`@vale-ts/spell`](packages/spell) | a Hunspell-compatible spell checker |
| [`@vale-ts/regex`](packages/regex) | .NET/RE2-flavored patterns translated to native `RegExp`, plus a literal prefilter |
| [`@vale-ts/tengo`](packages/tengo) | an interpreter for the Tengo subset `script` rules are written in |
| [`@vale-ts/models`](packages/models) | the trained models the NLP layer reads |

`@vale-ts/regex` and `@vale-ts/nlp` in particular stand on their own: the first
is a pattern translator that handles inline flag directives, .NET's
Unicode-aware `\b`, RE2's narrower `\s`, atomic groups and class subtraction;
the second is the only TypeScript implementation of `prose`'s tagger and
segmenter reading the same trained models.

## Compatibility

Vale declares its own behavior as 367 end-to-end cases: a configuration, a
document, the arguments to run with, and the exact output expected. This repo
runs those cases unmodified.

```console
bun run test:compat                      # this port against Vale's recorded output
bun run test:compat -- --reference       # and against the pinned Go binary
bun run test:compat -- --only lint/md    # one suite
bun run test:compat -- --self-check      # check the harness, not the port
```

Three numbers come out of it, and they answer different questions:

- **Matching the corpus** — does this port produce what Vale recorded?
- **Agreeing with the reference** — do the two implementations produce the same
  thing *on this machine*, with these converters installed? This is the number
  that matters, because a case whose recording depends on a Docutils version
  will differ for both implementations equally.
- **`--self-check`** — does the pinned Go binary reproduce its own recorded
  output here? Anything it fails is a property of the corpus or the machine, not
  of the port, and sets the ceiling for the other two.

The corpus and the binary are pinned in
[`tests/compat/pinned.ts`](tests/compat/pinned.ts) and fetched on demand;
neither is committed. Upgrading the pin means re-reading the diff of the `want:`
blocks, each of which is an assertion about Vale's output.

## Development

```console
bun install
bun test                    # every package's unit tests
bun run typecheck           # tsc across the workspace
bun run lint                # biome
bun run test:compat         # the compatibility suite
```

### How it fits together

```
          ┌─────────────┐
          │  @vale-ts/  │   patterns, tokenizers, speller, Tengo:
          │ regex · nlp │   no knowledge of Vale
          │ spell·tengo │
          └──────┬──────┘
                 │
          ┌──────▼──────┐
          │   /core     │   .vale.ini, Config, File, Block, Alert,
          │             │   and where a match goes
          └──────┬──────┘
                 │
       ┌─────────┴─────────┐
       │                   │
┌──────▼──────┐     ┌──────▼──────┐
│   /check    │     │    /lint    │   rules, and the readers that
│             │◄────┤             │   turn a document into blocks
└─────────────┘     └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  vale-ts    │   the facade, and /cli on top
                    └─────────────┘
```

Two conventions are worth knowing before reading the source.

**One offset unit.** Go counts bytes in some places and runes in others, and
converts between them; several of its subtlest functions exist only to do that.
This port has one unit — the JavaScript string index, a UTF-16 code unit — used
wherever Go uses a byte offset. Columns are the exception: a column is a count
of characters, which `strLen` returns.

**Synchronous.** Go lints files concurrently, and runs some rules within a block
concurrently too. This port is synchronous. Nothing about the result depends on
that in Go either — the comments there are explicit that the scheduler must not
be able to change an answer — so the two agree, and a caller who wants
parallelism can lint several files in separate workers. The one exception is
loading the tree-sitter grammars, which is async; `initCode()` does it once.

## Credit and license

Vale is by [Joseph Kato](https://github.com/jdkato) and the Vale contributors,
MIT-licensed. This is a port of their work, and the design, the heuristics and
most of the reasoning in the comments are theirs.

The trained models in `@vale-ts/models` are shipped byte for byte from
[`prose`](https://github.com/jdkato/prose) and
[`neurosnap/sentences`](https://github.com/neurosnap/sentences), both MIT.
`@vale-ts/spell` is a port of [`gospell`](https://github.com/jdkato/gospell).

This port is MIT-licensed; see [LICENSE](LICENSE).
