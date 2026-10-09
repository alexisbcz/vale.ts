/**
 * The configuration as `ls-config` prints it.
 *
 * Go gets this from `json.MarshalIndent(cfg, ...)`, so the field names, their
 * order and the `json:"-"` omissions are the struct's. Another tool parses it,
 * which makes all three part of the interface -- and is why it is spelled out
 * here rather than left to the port's own field naming.
 *
 * An empty list is `null` and an empty map is `{}`, which is what Go's nil
 * slice and initialized map marshal to. A list a configuration emptied on
 * purpose is indistinguishable from one never set, so it reads as `null` too;
 * nothing in Vale's own output depends on telling those two apart.
 */

import type { Config, Vocabulary } from "@vale-ts/core";
import { asMap } from "./util.ts";

/** An empty list as Go's nil slice marshals. */
function slice(values: readonly string[] | undefined): unknown {
	return values === undefined || values.length === 0 ? null : values;
}

/** A record as a Go map, whose keys are sorted when written. */
function map(value: Record<string, unknown> | undefined): unknown {
	return asMap(value ?? {});
}

/** A map whose values are lists, each of which may be nil. */
function mapOfSlices(value: Record<string, string[]> | undefined): unknown {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value ?? {})) out[k] = slice(v);
	return asMap(out);
}

/** A vocabulary, with Go's capitalized field names. */
function vocabulary(v: Vocabulary): unknown {
	return { Accepted: slice(v.accepted), Rejected: slice(v.rejected) };
}

/** The configuration, in the shape `ls-config` has always printed. */
export function configJSON(cfg: Config): unknown {
	const vocabularies: Record<string, unknown> = {};
	for (const [name, v] of Object.entries(cfg.vocabularies)) {
		vocabularies[name] = vocabulary(v);
	}

	return {
		BlockIgnores: mapOfSlices(cfg.blockIgnores),
		Checks: slice(cfg.checks),
		Formats: map(cfg.formats),
		Asciidoctor: map(cfg.asciidoctor),
		Sphinx: map(cfg.sphinx),
		FormatToLang: map(cfg.formatToLang),
		GBaseStyles: slice(cfg.gBaseStyles),
		GChecks: map(cfg.gChecks),
		IgnoredClasses: slice(cfg.ignoredClasses),
		IgnoredScopes: slice(cfg.ignoredScopes),
		MinAlertLevel: cfg.minAlertLevel,
		Vocab: slice(cfg.vocab),
		RuleToLevel: map(cfg.ruleToLevel),
		RuleToParams: map(
			Object.fromEntries(
				Object.entries(cfg.ruleToParams).map(([k, v]) => [k, map(v)]),
			),
		),
		SBaseStyles: mapOfSlices(cfg.sBaseStyles),
		SChecks: map(
			Object.fromEntries(Object.entries(cfg.sChecks).map(([k, v]) => [k, map(v)])),
		),
		SLevels: map(
			Object.fromEntries(Object.entries(cfg.sLevels).map(([k, v]) => [k, map(v)])),
		),
		SUnsets: mapOfSlices(cfg.sUnsets),
		SVocab: mapOfSlices(cfg.sVocab),
		StyleSources: map(cfg.styleSources),
		Vocabularies: map(vocabularies),
		SkippedScopes: slice(cfg.skippedScopes),
		Stylesheets: map(cfg.stylesheets),
		TokenIgnores: mapOfSlices(cfg.tokenIgnores),
		CommentDelimiters: map(cfg.commentDelimiters),
		WordTemplate: cfg.wordTemplate,
		RootINI: cfg.rootINI,
		Paths: slice(cfg.paths),
		ConfigFiles: slice(cfg.configFiles),
		NLPEndpoint: cfg.nlpEndpoint,
	};
}
