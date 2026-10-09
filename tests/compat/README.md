# The compatibility suite

Four tools, answering four different questions. Run them in this order when
something fails; each one narrows where the difference can be.

## `run.ts --self-check` — is the harness right?

Runs the **pinned Go binary** against Vale's own recorded output.

Anything it fails is a property of the corpus or of this machine — a converter
version, a dictionary that `vale sync` would have fetched, a default styles path
— and not of the port. This sets the ceiling for every other number here, so
it is the first thing to look at when a case fails.

```console
bun tests/compat/run.ts --self-check
```

## `run.ts` — does the port agree with Vale?

Runs **this port's CLI** against the same 367 cases.

```console
bun tests/compat/run.ts                      # against the recorded output
bun tests/compat/run.ts --reference          # and against the binary, side by side
bun tests/compat/run.ts --only lint/md -v
bun tests/compat/run.ts --report compat.md
```

`--reference` is the number that matters. "Matches the corpus" can drift with a
converter version; "agrees with the reference binary" is the two
implementations compared here and now, on the same inputs.

`--inproc` calls the library directly instead of spawning the CLI. A case that
fails both ways is an engine difference; one that fails only through the CLI is
in the argument handling or the output format. It is also much faster, which
makes it the one to use while working.

## `regex-diff.ts` — does the pattern translator match?

The narrower question underneath the suite: given the same pattern and the same
text, does `@vale-ts/regex` match where `regexp2` matches?

Each pattern becomes a one-token `existence` rule in a generated style, the real
binary lints a plain-text corpus with all of them, and its output is compared
against the same patterns run through this port. Plain text is deliberate:
nothing converts between the file and the block, so a column is a column and any
difference belongs to the engine.

```console
bun tests/compat/regex-diff.ts                      # Vale's own test styles
bun tests/compat/regex-diff.ts --styles ~/styles    # any style tree
bun tests/compat/regex-diff.ts --limit 1200 -v
```

Worth isolating, because a difference here is invisible until some rule in some
style quietly stops firing.

## `styles-diff.ts` — does it agree on real documents?

Vale's suite is a set of cases someone thought of. This is the other half: the
style packages people install — Microsoft, Google, proselint, write-good, alex,
Readability, Joblint — run over whatever documents are at hand, both
implementations compared line for line.

```console
bun tests/compat/styles-diff.ts
bun tests/compat/styles-diff.ts --docs ~/my-docs
bun tests/compat/styles-diff.ts --styles Microsoft,Google
```

## `bench.ts` — how fast is it?

```console
bun tests/compat/bench.ts --runs 5
```

Lints a real corpus with a real style, because that is the shape of the work and
because what dominates — the literal prefilter that rules a pattern out before
the engine runs — only shows up at that scale.

## What is fetched, and what is pinned

`bun run compat:fetch` downloads two things into `.cache/`, which is gitignored:

- Vale's `testdata/` at the commit in [`pinned.ts`](pinned.ts) — the corpus and
  the expectations both.
- The release binary that corpus belongs to.

Neither is committed: 30 MB of someone else's fixtures and 55 MB of someone
else's build. Pinning them says the same thing with none of the weight.

Upgrading the pin means re-reading the diff of `testdata/e2e/*.yaml`. Each
`want:` block is an assertion about Vale's output, and a changed one is either a
bug fixed upstream or a behavior this port now has to follow.

## The external converters

```console
pip install docutils         # reStructuredText
gem install asciidoctor      # AsciiDoc
apt install xsltproc         # XML transforms
```

A case needing one you do not have skips itself. `VALE_COMPAT_STRICT=1` makes
that a failure instead, which is what continuous integration sets — a suite that
silently stopped testing AsciiDoc would report a higher number for having tested
less.
