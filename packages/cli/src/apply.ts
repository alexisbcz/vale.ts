/**
 * `vale fix --apply`: writing a rule's fix back into the file.
 *
 * Only an unambiguous fix is written -- an alert whose action resolves to
 * exactly one suggestion, at a span no other fix touches. Everything else is
 * reported rather than guessed at: an alert with several suggestions, one whose
 * fix overlaps another's, or one whose reported position no longer holds its
 * match. A file with nothing to apply is never rewritten, so its timestamp is
 * left alone too.
 *
 * # Offsets
 *
 * Go maps an alert's line and character columns onto byte offsets. Here the one
 * offset unit is the JavaScript string index, so `spanOf` maps columns --
 * counted in characters -- onto indices into the file's text.
 */

import type { Alert, CLIFlags, Config, File } from "@vale-ts/core";
import {
	fileExists,
	isDir,
	newE100,
	readPipeline,
} from "@vale-ts/core";
import { fixAlert, Manager } from "@vale-ts/check";
import { createLinter } from "@vale-ts/lint";
import { readFileSync, writeFileSync } from "node:fs";
import { println } from "./out.ts";
import { printJSON } from "./util.ts";

/** One unambiguous fix, resolved to the span of text it rewrites. */
export interface FixEdit {
	begin: number;
	end: number;
	text: string;
	check: string;
	line: number;
	col: number;
}

/** An alert `--apply` chose not to touch, and why. */
export interface FixSkip {
	Check: string;
	Line: number;
	Span: number[];
	Reason: string;
}

/** One file's report: what was written and what was left. */
export interface FixedFile {
	Path: string;
	Applied: number;
	Skipped: FixSkip[];
}

/** Lints the given paths and writes every unambiguous fix back to disk. */
export function applyFixes(paths: readonly string[], flags: CLIFlags): void {
	if (paths.length === 0) {
		throw newE100("fix", new Error("at least one path expected"));
	}
	for (const p of paths) {
		if (!fileExists(p) && !isDir(p)) {
			throw newE100("fix", new Error(`path '${p}' does not exist`));
		}
	}

	const cfg = readPipeline(flags, false);
	const linter = createLinter(Manager.create(cfg));
	const linted = linter.lint(paths, flags.glob);

	const reports: FixedFile[] = [];
	for (const f of linted) {
		const report = fixFile(f, cfg);
		if (report.Applied > 0 || report.Skipped.length > 0) reports.push(report);
	}

	if (flags.output === "JSON") {
		printJSON(reports.length === 0 ? null : reports);
		return;
	}

	for (const r of reports) {
		println(`${r.Path}: applied ${r.Applied}, skipped ${r.Skipped.length}`);
		for (const s of r.Skipped) {
			println(`  ${s.Line}:${s.Span[0]}\t${s.Check}\t${s.Reason}`);
		}
	}
}

/** What one alert's action resolved to, or why it could not. */
interface Resolved {
	suggestions: string[];
	err: string;
}

/** Resolves and applies one file's fixes, reporting what it did. */
export function fixFile(f: File, cfg: Config): FixedFile {
	const report: FixedFile = { Path: f.path, Applied: 0, Skipped: [] };

	const raw = readFileSync(f.path, "utf8");
	const starts = lineOffsets(raw);

	const skip = (a: Alert, reason: string): void => {
		report.Skipped.push({
			Check: a.check,
			Line: a.line,
			Span: a.span,
			Reason: reason,
		});
	};

	// Repeated identical misspellings resolve to the same suggestions, and the
	// spelling fixer builds a manager per call; one lookup each is plenty.
	const cache = new Map<string, Resolved>();

	const candidates: FixEdit[] = [];
	for (const a of f.sortedAlerts()) {
		if (a.action.name === "") continue;

		const key = `${a.check}\u0000${a.match}`;
		let got = cache.get(key);
		if (got === undefined) {
			// The lint pass has usually resolved the fix already; spelling
			// leaves it for here, since ranking a dictionary is per word.
			got = { suggestions: a.suggestions, err: "" };
			if (got.suggestions.length === 0) {
				try {
					got.suggestions = fixAlert(a, cfg);
				} catch (err) {
					got.err = err instanceof Error ? err.message : String(err);
					got.suggestions = [];
				}
			}
			cache.set(key, got);
		}

		if (got.err !== "") {
			skip(a, got.err);
			continue;
		}
		if (got.suggestions.length !== 1) {
			skip(a, `${got.suggestions.length} suggestions`);
			continue;
		}

		const at = spanOf(raw, starts, a);
		if (at === null) {
			skip(a, "match is not at its reported position");
			continue;
		}

		let [begin, end] = at;
		if (got.suggestions[0] === "") [begin, end] = widenRemoval(raw, begin, end);

		candidates.push({
			begin,
			end,
			text: got.suggestions[0] as string,
			check: a.check,
			line: a.line,
			col: a.span[0] as number,
		});
	}

	const kept = resolveEdits(candidates, report);
	if (kept.length === 0) return report;

	let out = "";
	let last = 0;
	for (const e of kept) {
		out += raw.slice(last, e.begin) + e.text;
		last = e.end;
	}
	out += raw.slice(last);

	writeFileSync(f.path, out);

	report.Applied = kept.length;
	return report;
}

/**
 * Orders the candidates and keeps the ones that stand alone.
 *
 * Two rules asking for the same rewrite collapse into one; a span touched by
 * two different rewrites is a conflict, and every member of an overlapping
 * cluster is reported rather than resolved.
 */
export function resolveEdits(
	candidates: readonly FixEdit[],
	report: FixedFile,
): FixEdit[] {
	const sorted = [...candidates].sort((a, b) =>
		a.begin !== b.begin ? a.begin - b.begin : a.end - b.end,
	);

	const deduped: FixEdit[] = [];
	for (const c of sorted) {
		const prev = deduped[deduped.length - 1];
		if (
			prev !== undefined &&
			prev.begin === c.begin &&
			prev.end === c.end &&
			prev.text === c.text
		) {
			continue;
		}
		deduped.push(c);
	}

	const kept: FixEdit[] = [];
	for (let i = 0; i < deduped.length; ) {
		let j = i + 1;
		let maxEnd = (deduped[i] as FixEdit).end;
		while (j < deduped.length && (deduped[j] as FixEdit).begin < maxEnd) {
			maxEnd = Math.max(maxEnd, (deduped[j] as FixEdit).end);
			j++;
		}

		if (j === i + 1) {
			kept.push(deduped[i] as FixEdit);
		} else {
			const names = deduped.slice(i, j).map((e) => e.check);
			for (let k = i; k < j; k++) {
				const edit = deduped[k] as FixEdit;
				const others = names.filter((_, n) => n !== k - i);
				report.Skipped.push({
					Check: edit.check,
					Line: edit.line,
					Span: [edit.col],
					Reason: `overlaps ${others.join(", ")}`,
				});
			}
		}
		i = j;
	}

	return kept;
}

/**
 * Takes one adjacent space along with a removed match, so deleting a word does
 * not leave two spaces behind: the one after it when there is one, otherwise
 * the one before.
 */
export function widenRemoval(
	raw: string,
	begin: number,
	end: number,
): [number, number] {
	if (end < raw.length && raw[end] === " ") return [begin, end + 1];
	if (begin > 0 && raw[begin - 1] === " ") return [begin - 1, end];
	return [begin, end];
}

/**
 * Maps an alert's line and character columns onto offsets into the file as it
 * sits on disk, refusing the mapping unless the text there is the alert's own
 * match -- the file may have changed since the lint pass, or the span may
 * describe text extraction rewrote.
 */
export function spanOf(
	raw: string,
	starts: readonly number[],
	a: Alert,
): [number, number] | null {
	const from = a.span[0] ?? 0;
	const to = a.span[1] ?? 0;

	if (a.span.length !== 2 || from < 1 || to < from || a.line < 1 ||
		a.line > starts.length) {
		return null;
	}

	const ls = starts[a.line - 1] as number;
	const le = a.line < starts.length ? (starts[a.line] as number) : raw.length;
	const line = raw.slice(ls, le);

	const begin = charIndex(line, from - 1);
	const end = charIndex(line, to);
	if (begin < 0 || end < 0) return null;

	const b = ls + begin;
	const e = ls + end;
	if (raw.slice(b, e) !== a.match) return null;

	return [b, e];
}

/**
 * The string index of the `n`-th character of `s`, or `-1` when `s` ends first.
 *
 * A column is a count of characters, so an astral character counts once here
 * and takes two indices -- which is why this walks rather than adds.
 */
function charIndex(s: string, n: number): number {
	let i = 0;
	let seen = 0;
	while (seen < n) {
		if (i >= s.length) return -1;
		i += (String.fromCodePoint(s.codePointAt(i) as number)).length;
		seen++;
	}
	return i;
}

/** The offset at which each line of `raw` begins. */
export function lineOffsets(raw: string): number[] {
	const starts = [0];
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "\n") starts.push(i + 1);
	}
	return starts;
}
