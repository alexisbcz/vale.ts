/**
 * The reader tests that drive the whole linter.
 *
 * Each of these is a Go test whose subject is a document going in and alerts
 * coming out: it needs a `Manager` from `@vale-ts/check`, a configuration and
 * a styles path, which makes it an end-to-end case rather than a unit one.
 * They live in `tests/compat` -- `bun run test:compat` -- and are listed here
 * so the Go file they came from is accounted for.
 */

import { test } from "bun:test";

// `internal/lint/lint_test.go`: every fixture under `testdata/fixtures` is
// linted and its alerts compared against a snapshot.
test.skip("the fixtures and their alerts belong to the end-to-end compatibility suite", () => {});

// `internal/lint/concurrent_test.go`: the same corpus linted many times over,
// checking that nothing a reader keeps is shared between files.
test.skip("linting the same corpus repeatedly belongs to the end-to-end compatibility suite", () => {});

// `internal/lint/skip_test.go`: which files a run reads at all, which is the
// linter's question rather than a reader's.
test.skip("which files a run reads belongs to the end-to-end compatibility suite", () => {});

// `internal/lint/hooks_test.go`: the block and rule hooks, which fire from the
// linter.
test.skip("the block and rule hooks belong to the end-to-end compatibility suite", () => {});

// `internal/lint/adoc_pool_test.go` and `rst_pool_test.go`: that a run leaves
// no helper processes behind, and that a pooled interpreter converts a
// document exactly as a spawned one would. This port has no pool -- one
// process per document, see `test/external.md` -- so there is nothing to keep
// warm and nothing to leak.
test.skip("the process pool's own tests do not apply to this port", () => {});
