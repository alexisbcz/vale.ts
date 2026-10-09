/**
 * Reading reStructuredText, through Docutils.
 *
 * reStructuredText has no parser outside Python, so the document is handed to
 * Docutils and the HTML that comes back is what the walker reads. Which
 * Docutils is not obvious: `rst2html` is installed with a shebang naming the
 * interpreter of the environment it was installed into, and on a machine with
 * several Pythons the `python3` on PATH often cannot import it. So the script
 * is asked which interpreter it runs on, and that one is used.
 *
 * # Sphinx
 *
 * Docutils knows its own directives and roles. A Sphinx project's files use
 * Sphinx's and its extensions' as well, and Docutils drops the body of every
 * directive it does not know -- so a `versionadded` or a `tab-set` would take
 * its prose out of the document with it.
 *
 * `RST_SERVER` fills the gap. It is the Python Vale runs: it registers a
 * fallback for every unknown directive (prose, except for a named few holding
 * code, data, or generated content) and for every unknown role (code, except
 * for the reference and interface roles, whose text is prose), parses the
 * Docutils flags through Docutils' own command-line handling so the settings
 * cannot drift from a plain `rst2html` invocation, and then converts
 * documents over a length-framed protocol. A project's `[sphinx]` section adds
 * to both lists. See #294.
 *
 * Go keeps that interpreter up for the whole run; this port spawns it per
 * document (see `external.ts`). The script is unchanged either way: one
 * document is written, one reply is read, and the process then sees end of
 * input and stops.
 */

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { Config, File } from "@vale-ts/core";
import { newE100, which } from "@vale-ts/core";
import { executeWithInput } from "./external.ts";

/** What a reStructuredText reader needs from the linter. */
export interface RSTHost {
	config: Config;
	transform(f: File): string;
	lintHTMLTokens(f: File, raw: string, offset: number): void;
	lintMetadata(f: File): void;
}

/**
 * Sphinx-style code directives, rewritten to the plain `::` Docutils knows.
 *
 * The runtime options a directive may carry (`:caption:`, `:linenos:`) are
 * matched too, so they do not survive as prose under a literal block.
 */
const RE_CODE_BLOCK = /\.\. (?:raw|code(?:-block)?):: *(?:[\w-]+)?(?:\s+:\w+:.*)*/g;

/**
 * A `contents` directive repeats the document's headings, so it is read as
 * code. See https://github.com/errata-ai/vale/v2/issues/119.
 */
const RE_SPHINX = /\.\. contents::/g;

const RST_ARGS = [
	"--quiet",
	"--halt=5",
	"--report=5",
	"--link-stylesheet",
	"--no-file-insertion",
	"--no-toc-backlinks",
	"--no-footnote-backlinks",
	"--no-section-numbering",
];

/**
 * Puts the spawned Python in UTF-8 mode.
 *
 * Docutils reads standard input through Python's text layer, which on Windows
 * decodes with the console's code page, cp1252, and no Docutils flag reaches
 * below that layer: a document's UTF-8 went in as mojibake and came out the
 * same. The framed interpreter is not affected, since it reads and writes
 * bytes.
 */
const RST_ENV: Readonly<Record<string, string>> = {
	PYTHONUTF8: "1",
	PYTHONIOENCODING: "utf-8",
};

/** The Python Vale runs to convert reStructuredText. See the module comment. */
const RST_SERVER = `import json, re, sys
from docutils import nodes
from docutils.core import Publisher, publish_string
from docutils.parsers.rst import Directive, directives, roles
from docutils.statemachine import StringList

CONFIG = json.loads(sys.argv[1] or "{}")

class AnyOptions(dict):
    def __contains__(self, key):
        return True
    def __getitem__(self, key):
        return directives.unchanged
    def get(self, key, default=None):
        return directives.unchanged

class Prose(Directive):
    optional_arguments = 1
    final_argument_whitespace = True
    has_content = True
    option_spec = AnyOptions()
    def run(self):
        # The first line of the argument block is the argument -- a version, a
        # signature, a title. Any lines indented under it are prose, as in
        # "versionadded", whose text sits there rather than in the content.
        node = nodes.container()
        if self.arguments:
            rest = self.arguments[0].split("\\n")[1:]
            if rest:
                src = self.state.document.current_source
                block = StringList(rest, items=[(src, self.lineno + i) for i in range(len(rest))])
                self.state.nested_parse(block, self.lineno, node)
        if self.content:
            self.state.nested_parse(self.content, self.content_offset, node)
        return [node]

class Skip(Prose):
    def run(self):
        # A literal block rather than nothing: the text is then masked out of
        # the source, so a match elsewhere is not placed on a copy in here.
        text = "\\n".join(list(self.arguments) + list(self.content))
        return [nodes.literal_block(text, text)]

CODE = {
    "toctree", "literalinclude", "highlight", "index", "tabularcolumns",
    "math", "graphviz", "graph", "digraph", "inheritance-diagram",
    "productionlist", "doctest", "testcode", "testoutput", "testsetup",
    "testcleanup", "currentmodule", "module", "default-domain",
    "codeauthor", "sectionauthor", "cssclass", "rst-class",
} | set(CONFIG.get("code") or [])

_directive = directives.directive
def directive(name, language_module, document):
    fn, messages = _directive(name, language_module, document)
    if fn is not None:
        return fn, messages
    norm = name.lower()
    if norm in CODE or norm.startswith("auto"):
        return Skip, []
    return Prose, []
directives.directive = directive

PROSE = {
    "ref", "doc", "any", "numref", "term", "guilabel", "menuselection",
    "abbr", "dfn",
} | set(CONFIG.get("prose") or [])
TARGETED = {"ref", "doc", "any", "numref"}
_title = re.compile(r"^(.*\\S)\\s*<[^<>]+>$", re.S)

def prose_role(name, rawtext, text, lineno, inliner, options={}, content=[]):
    m = _title.match(text)
    if m:
        text = m.group(1)
    elif name.lower().split(":")[-1] in TARGETED:
        return [nodes.literal(rawtext, text)], []
    # Plain text, not an inline element: the words are part of the sentence.
    return [nodes.Text(text)], []

def code_role(name, rawtext, text, lineno, inliner, options={}, content=[]):
    return [nodes.literal(rawtext, text)], []

_role = roles.role
def role(name, language_module, lineno, reporter):
    fn, messages = _role(name, language_module, lineno, reporter)
    if fn is not None:
        return fn, messages
    base = name.lower().split(":")[-1]
    return (prose_role if base in PROSE else code_role), []
roles.role = role

_pub = Publisher()
_pub.set_components("standalone", "restructuredtext", "html4css1")
_pub.process_command_line(argv=sys.argv[2:])
SETTINGS = _pub.settings

buf = sys.stdin.buffer
out = sys.stdout.buffer

while True:
    header = buf.readline()
    if not header:
        break
    n = int(header)
    if n < 0:
        break
    doc = buf.read(n) if n else b""
    try:
        b = publish_string(
            source=doc.decode("utf-8"),
            source_path="<stdin>",
            writer_name="html4css1",
            settings=SETTINGS,
        )
        out.write(b"ok %d\\n" % len(b))
        out.write(b)
    except Exception as e:
        m = str(e).encode("utf-8", "replace")
        out.write(b"err %d\\n" % len(m))
        out.write(m)
    out.flush()`;

/**
 * The names Python is installed under -- `python`, `python3`, `python3.12`,
 * `pypy3` -- and nothing else.
 */
const RE_PYTHON = /^(?:python|pypy)[0-9.]*(?:\.exe)?$/i;

/** The `rst2html` on PATH, or "". */
export function rstExe(): string {
	return which(["rst2html", "rst2html.py", "rst2html-3", "rst2html-3.py"]);
}

/** The first line of a file, or "" when it cannot be read. */
function firstLine(p: string): string {
	let fd: number;
	try {
		fd = openSync(realpathSync(p), "r");
	} catch {
		return "";
	}
	try {
		const buf = Buffer.alloc(512);
		const n = readSync(fd, buf, 0, buf.length, 0);
		const text = buf.subarray(0, n).toString("utf8");
		const nl = text.indexOf("\n");
		return nl < 0 ? text : text.slice(0, nl + 1);
	} catch {
		return "";
	} finally {
		closeSync(fd);
	}
}

/**
 * The Python that can import Docutils, read from `rst2html`'s shebang.
 *
 * The answer is only used when it names Python. `rst2html` is not always the
 * script it looks like: a version manager can put a shell wrapper on PATH
 * under that name, and the wrapper's shebang names its own shell. Passing the
 * server source to a shell runs its first line, `import sys`, as a command --
 * which is a real program on a machine with ImageMagick. See #1137.
 */
export function rstInterpreter(exe: string): string {
	const line = firstLine(exe);
	if (!line.startsWith("#!")) return "";

	const fields = line
		.slice(2)
		.trim()
		.split(/\s+/)
		.filter((f) => f !== "");
	if (fields.length === 0) return "";

	// `#!/usr/bin/env python3` names the interpreter in the second field.
	let python = fields[0];
	if (path.basename(python) === "env") {
		if (fields.length < 2) return "";
		python = fields[1];
	}

	if (!RE_PYTHON.test(path.basename(python))) return "";
	if (!/[/\\]/.test(python)) {
		// A bare name -- what follows `env` -- is resolved on PATH. A shebang
		// writes a path the POSIX way whatever the host does, so the platform's
		// own idea of an absolute path is not the judge: on Windows every
		// `#!/usr/bin/python3` in the world is a relative path to nothing.
		return which([python]);
	}
	return python;
}

/** Whether `exe` begins with `#!`, naming an interpreter. */
function hasShebang(exe: string): boolean {
	return firstLine(exe).startsWith("#!");
}

/** A Python on PATH that can import `module`, or "". */
function pythonWith(module: string): string {
	for (const name of ["python3", "python", "py"]) {
		const p = which([name]);
		if (p === "") continue;
		const probe = spawnSync(p, ["-c", `import ${module}`], { encoding: "utf8" });
		if (probe.status === 0) return p;
	}
	return "";
}

/** The server's argument list: the `[sphinx]` section as JSON, then the flags. */
function rstAttrs(config: string): string[] {
	return [config, ...RST_ARGS];
}

/**
 * The argv for reaching Docutils directly, or null.
 *
 * Only the interpreter the script itself names will do. Falling back to a
 * Python on PATH sounds harmless -- the probe below still has to pass -- but
 * it is a different Docutils, and documents it converts would have been
 * converted differently by a spawned `rst2html`. On Windows it picked up an
 * interpreter where the two disagree about output encoding, and the same
 * document came back as `naïve` one way and `naÃ¯ve` the other.
 *
 * The one exception is a script with no shebang at all: on Windows, pip
 * installs `rst2html` as a launcher executable, which names nothing to read,
 * and the spawned fallback cannot register the directives a Sphinx project
 * needs. There, a Python on PATH that imports Docutils is tried, and the
 * round trip below, with its non-ASCII character, guards the encoding.
 */
function rstProbe(exe: string): string[] | null {
	let python = rstInterpreter(exe);
	if (python === "" && !hasShebang(exe)) python = pythonWith("docutils");
	if (python === "") return null;

	const candidate = [python, "-c", RST_SERVER];

	// Trust it only after a document has made the round trip. The probe
	// carries a non-ASCII character on purpose: a mismatched default encoding
	// is what broke the first version of the AsciiDoc pool, and an ASCII-only
	// probe would have passed anyway.
	let got: string;
	try {
		got = framedConvert(candidate, rstAttrs("{}"), "naïve body\n");
	} catch {
		return null;
	}
	return got.includes("naïve body") ? candidate : null;
}

/** The probe's answer, computed once. */
let rstDirect: string[] | null | undefined;

function rstFastPath(exe: string): string[] | null {
	rstDirect ??= rstProbe(exe);
	return rstDirect;
}

/**
 * Converts one document through the framed protocol.
 *
 * The length is a count of bytes, because the script reads bytes: a document
 * can contain any sequence a delimiter might use, so a request carries its
 * size rather than a terminator.
 *
 *     request   <byteLength> LF <bytes>
 *     response  "ok " <byteLength> LF <bytes>
 *               "err " <byteLength> LF <message>
 */
function framedConvert(
	argv: readonly string[],
	attrs: readonly string[],
	text: string,
): string {
	const body = Buffer.from(text, "utf8");
	const input = Buffer.concat([Buffer.from(`${body.length}\n`, "utf8"), body]);

	const result = spawnSync(argv[0], [...argv.slice(1), ...attrs], {
		input,
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, ...RST_ENV },
	});

	if (result.error !== undefined && result.error !== null) throw result.error;

	const out: Buffer = result.stdout ?? Buffer.alloc(0);
	const nl = out.indexOf(0x0a);
	if (nl < 0) {
		const err = (result.stderr ?? Buffer.alloc(0)).toString("utf8").trim();
		throw new Error(err !== "" ? err : "no reply from the converter");
	}

	const header = out.subarray(0, nl).toString("utf8").trim();
	const sep = header.indexOf(" ");
	if (sep < 0) throw new Error(`bad reply: ${JSON.stringify(header)}`);

	const status = header.slice(0, sep);
	const size = Number.parseInt(header.slice(sep + 1), 10);
	if (!Number.isFinite(size)) {
		throw new Error(`bad reply length: ${JSON.stringify(header)}`);
	}

	const payload = out.subarray(nl + 1, nl + 1 + size).toString("utf8");
	if (status === "err") throw new Error(payload);
	return payload;
}

/** The `[sphinx]` section as the server reads it. */
function sphinxConfig(cfg: Config): string {
	return JSON.stringify({
		code: cfg.sphinxNames("CodeDirectives"),
		prose: cfg.sphinxNames("ProseRoles"),
	});
}

/** Converts one document, through Docutils directly when it can be reached. */
function callRST(host: RSTHost, text: string, exe: string): string {
	const direct = rstFastPath(exe);
	if (direct !== null) {
		return rstBody(
			framedConvert(direct, rstAttrs(sphinxConfig(host.config)), text),
		);
	}
	return rstBody(executeWithInput(exe, text, RST_ARGS, RST_ENV));
}

/** The document body of a full `rst2html` page. */
export function rstBody(htmlArg: string): string {
	const html = htmlArg.replaceAll("\r", "");

	let bodyStart = html.indexOf("<body>\n");
	if (bodyStart < 0) bodyStart = -7;

	let bodyEnd = html.indexOf("\n</body>");
	if (bodyEnd < 0 || bodyEnd >= html.length) {
		bodyEnd = Math.max(html.length - 1, 0);
	}

	return html.slice(bodyStart + 7, bodyEnd);
}

/** The document as Docutils is given it. */
export function prepareRST(host: RSTHost, f: File): string {
	let s = host.transform(f);
	s = s.replace(RE_SPHINX, ".. code::");
	s = s.replace(RE_CODE_BLOCK, "::");
	return s;
}

/** Lints a document from its converted form. */
export function lintRSTHTML(host: RSTHost, f: File, html: string): void {
	host.lintMetadata(f);
	host.lintHTMLTokens(f, html, 0);
}

/** Reads a reStructuredText file. */
export function lintRST(host: RSTHost, f: File): void {
	const exe = rstExe();
	if (exe === "") {
		throw newE100(
			f.path,
			new Error("rst2html not found; it's needed to read reStructuredText"),
		);
	}

	const s = prepareRST(host, f);

	let html: string;
	try {
		html = callRST(host, s, exe);
	} catch (err) {
		throw newE100(f.path, err);
	}

	lintRSTHTML(host, f, html);
}

/**
 * A batch is several documents converted together, joined by a literal block
 * holding a token no document has and split apart again on it.
 *
 * Docutils parses at a steady couple of milliseconds per kilobyte, so a file
 * of a thousand docstrings costs the same whether they are sent one at a time
 * or all at once -- and one at a time, each paid for its own interpreter.
 */
const RST_SPLIT_MARK = "vale-split-9d1f7c";
const RST_CHUNK_BYTES = 32 * 1024;
const RST_SPLIT = `\n\n::\n\n   ${RST_SPLIT_MARK}\n\n`;
const RE_RST_SPLIT = new RegExp(
	`<pre class="literal-block">\\s*${RST_SPLIT_MARK}\\s*</pre>\\n?`,
);

/** Converts the documents in chunks, and returns each one's HTML in order. */
export function convertRSTBatch(host: RSTHost, docs: readonly string[]): string[] {
	const exe = rstExe();
	if (exe === "") throw new Error("rst2html not found");

	// Chunks of consecutive documents, each up to RST_CHUNK_BYTES.
	const chunks: string[][] = [];
	let size = 0;
	for (const doc of docs) {
		if (chunks.length === 0 || size + doc.length > RST_CHUNK_BYTES) {
			chunks.push([]);
			size = 0;
		}
		chunks[chunks.length - 1].push(doc);
		size += doc.length;
	}

	const out: string[] = [];
	for (const chunk of chunks) {
		const html = callRST(host, chunk.join(RST_SPLIT), exe);
		const parts = html.split(RE_RST_SPLIT);
		if (parts.length !== chunk.length) {
			throw new Error(
				`rst batch: ${chunk.length} documents, ${parts.length} parts`,
			);
		}
		out.push(...parts);
	}
	return out;
}
