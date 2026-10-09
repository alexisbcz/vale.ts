/**
 * What this port is a port *of*.
 *
 * Both of these are pinned deliberately. The test corpus is Vale's own
 * `testdata/`, which carries the expected output of every case it declares --
 * so a change upstream is a change to what compatibility means, and should be
 * a visible commit here rather than a silent drift. The binary is pinned to the
 * release that corpus belongs to, so that running the two side by side compares
 * like with like.
 */

/** The upstream repository the corpus and the reference binary come from. */
export const UPSTREAM = "https://github.com/vale-cli/vale";

/**
 * The commit the corpus is taken from.
 *
 * Upgrading it means re-reading the diff of `testdata/e2e/*.yaml`: each `want:`
 * block is an assertion about Vale's output, and a changed one is either a
 * bug fixed upstream or a behavior this port has to follow.
 */
export const CORPUS_COMMIT = "cfb21a4ce87238bcfb44b90e8e0db9e0e91d6c09";

/** The release whose behavior this port reproduces. */
export const REFERENCE_VERSION = "3.24.0";

/** The release asset for a platform, as Vale names them. */
export function referenceAsset(
	platform: string,
	arch: string,
): { name: string; url: string } {
	const os =
		platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
	const cpu = arch === "arm64" ? "arm64" : "64-bit";
	const ext = os === "Windows" ? "zip" : "tar.gz";
	const name = `vale_${REFERENCE_VERSION}_${os}_${cpu}.${ext}`;
	return {
		name,
		url: `${UPSTREAM}/releases/download/v${REFERENCE_VERSION}/${name}`,
	};
}

/**
 * The flags every case runs with.
 *
 * They pin the output format and keep results comparable across machines:
 * `--normalize` and `--relative` make paths comparable, `--sort` makes the
 * order deterministic, and `--no-global` keeps whoever is running the suite
 * out of it.
 */
export const SHARED_FLAGS = [
	"--output=line",
	"--sort",
	"--normalize",
	"--relative",
	"--no-global",
];

/**
 * The external converters a case may need, and every spelling Vale accepts.
 *
 * A case is skipped when none of its alternatives resolve, so the suite runs on
 * a machine with none of them installed -- and `VALE_COMPAT_STRICT` turns that
 * skip into a failure, which is what continuous integration should set.
 */
export const TOOL_ALTERNATIVES: Record<string, string[]> = {
	rst2html: ["rst2html", "rst2html.py", "rst2html-3", "rst2html-3.py"],
	dita: ["dita", "dita.bat"],
	xsltproc: ["xsltproc", "xsltproc.exe"],
	asciidoctor: ["asciidoctor", "asciidoctor.bat"],
	typst2vast: ["typst2vast"],
};
