# The external converters

Four of the readers hand the document to a program Vale does not ship. Each
one throws Vale's own "not found" error when the program is missing -- a
document is never silently skipped -- and each test that needs one skips
itself with a note saying so.

| Reader | Needs | Used for |
| --- | --- | --- |
| `rst.ts` | `rst2html` (Docutils), and the Python it names | reStructuredText, and the Sphinx directives and roles a project adds |
| `adoc.ts` | `asciidoctor` | AsciiDoc |
| `dita.ts` | `dita` (DITA Open Toolkit) | DITA |
| `typst.ts` | `typst2vast` | Typst |
| `xml.ts` | `xsltproc` | XML, through the stylesheet the file's section names |

Everything else converts in process and needs nothing installed: Markdown,
HTML, MDX, MyST, Quarto, Org, QDoc, plain text, Jupyter notebooks, and every
source file read for its comments.

## Installing them

```sh
# Docutils. Any Python will do; `rst.ts` reads the interpreter out of
# rst2html's shebang, so the one that can import Docutils is the one used.
python3 -m pip install docutils

# Asciidoctor.
gem install asciidoctor

# The DITA Open Toolkit: download a release and put its `bin` on PATH.
#   https://www.dita-ot.org/download

# typst2vast.
cargo install typst2vast

# xsltproc, from libxslt.
#   apt install xsltproc | brew install libxslt | pacman -S libxslt
```

## Why there is no process pool

Go keeps a pool of long-lived helper processes (`internal/lint/proc_pool.go`):
converting a document costs a few milliseconds, but starting Python or Ruby
costs fifty to a hundred and sixty, and Vale was paying that once per file.

This port spawns one process per document instead. A pool has to read one
reply while the next document is being written, which is asynchronous, and
every reader here is synchronous -- so the pool would change the whole call
chain rather than one file. Go's own fallback path, for a machine where a pool
cannot be established, does exactly what this does.

reStructuredText keeps the one piece the pool existed to carry: the Python
that registers the Sphinx directives and roles. `RST_SERVER` in `rst.ts` is
run per document over the same length-framed protocol the pool used, so an
unknown directive's prose still reaches the document. See `#294`.
