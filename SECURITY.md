# Security policy

vale.ts reads configuration, style packages and documents that may come from
someone else: a `.vale.ini` in a repository you cloned, a style downloaded by
`sync`, a Tengo script in a rule. Problems in how those are handled are what
this policy is for — a path that escapes the styles directory, a zip that
writes outside its target, a script rule that reaches past its sandbox, a
pattern that hangs the process.

## Reporting

Please report vulnerabilities privately, through GitHub's
[private vulnerability reporting](https://github.com/alexisbcz/vale.ts/security/advisories/new),
rather than in a public issue. Include the version, the input that triggers
it, and what happens.

You should hear back within a week. A fix is released as a patch version of
every affected package, and the advisory is published once it is out.

## Supported versions

Only the latest release receives fixes while the project is at 0.x.

## Out of scope

Bugs in Vale itself, unless this port reproduces them; and the external
converters (Docutils, Asciidoctor, DITA-OT, xsltproc) that some formats shell
out to, which have their own maintainers.
