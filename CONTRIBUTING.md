# Contributing

```console
bun install
bun test                 # every package's unit tests
bun run typecheck        # tsc, package by package, leaves first
bun run lint             # biome
bun run fmt              # biome, writing fixes
```

## The compatibility suite

This is the thing that makes the port meaningful, and the thing to run before
claiming a change is correct.

```console
bun run compat:fetch                 # the corpus and the pinned Go binary
bun run test:compat                  # this port against Vale's recorded output
bun run test:compat -- --reference   # and against the binary, side by side
bun run test:compat -- --only lint/md --verbose
bun run test:compat -- --self-check  # does the binary match its own corpus here?
```

Run `--self-check` first when a case fails. If the pinned binary fails the same
case on your machine, the difference is in the corpus or in your converters, and
the port is not the thing to change.

The external converters some cases need:

```console
pip install docutils                 # reStructuredText
gem install asciidoctor              # AsciiDoc
apt install xsltproc                 # XML transforms
```

Cases needing a converter you do not have skip themselves. Set
`VALE_COMPAT_STRICT=1` to make that a failure instead, which is what continuous
integration does.

## House style

Read [`docs/porting-notes.md`](docs/porting-notes.md) first; it explains the two
conventions that run through everything (one offset unit, synchronous), and the
places where this port and Vale are known to differ.

- **Tabs.** Biome enforces the rest.
- **Comments explain why.** The Go codebase this is ported from is unusually
  well commented, and most of those comments record a bug that a heuristic
  exists to prevent. Carry that reasoning across; a comment restating what the
  next line does is worse than none.
- **Faithful over clever.** When Go does something that looks wrong, assume
  there is a case behind it and look for the test. If you improve on it, say so
  in the comment, because the compatibility suite will notice.
- **No new dependency without a reason in the pull request.** Several
  dependencies were written out by hand rather than taken, and the table in the
  porting notes says which and why.

## Adding a rule type or a format

A rule type is a file in `packages/check/src/` and a case in `newRule`. A format
is a file in `packages/lint/src/` and a call to `addReader` in that package's
`index.ts`; the reader's job is to produce HTML and hand it to
`lintHTMLTokens`, which does the rest.

Either way, the test that counts is an end-to-end case. If Vale has one, the
compatibility suite already runs it.
