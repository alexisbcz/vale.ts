/**
 * The `text/template` subset.
 *
 * The four templates Vale ships are the specification for what has to work, so
 * two of them -- `line.tmpl`, which is the plainest, and `cli.tmpl`, which uses
 * every action and almost every function -- are rendered here against
 * hand-built data.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { FUNCS } from "../src/funcs.ts";
import { capture, stdout } from "../src/out.ts";
import { sprintf, Template, truthy } from "../src/template.ts";
import { setTerminal } from "../src/tty.ts";

beforeEach(() => {
	setTerminal(false, false);
});

/**
 * Renders `src` against `data`.
 *
 * The template's text and the output of a printing function such as
 * `renderTable` share one stream, as they do in Go, so what comes back is the
 * two interleaved in the order they were written.
 */
async function renderOrdered(src: string, data: unknown): Promise<string> {
	const captured = await capture(() => {
		new Template(src, "test.tmpl", FUNCS).execute(data, stdout);
	});
	return captured.out;
}

describe("actions and literals", () => {
	test("text passes through", async () => {
		expect(await renderOrdered("hello\n", null)).toBe("hello\n");
	});

	test("the dot and a field chain", async () => {
		expect(await renderOrdered("{{.A.B}}", { A: { B: "x" } })).toBe("x");
		expect(await renderOrdered("{{.}}", "y")).toBe("y");
	});

	test("$ is the root, whatever the dot is", async () => {
		expect(
			await renderOrdered("{{range .Items}}{{$.Name}}{{end}}", {
				Name: "n",
				Items: [1, 2],
			}),
		).toBe("nn");
	});

	test("literals", async () => {
		expect(await renderOrdered('{{"a\\tb"}}', null)).toBe("a\tb");
		expect(await renderOrdered("{{`raw\\n`}}", null)).toBe("raw\\n");
		expect(await renderOrdered("{{42}}", null)).toBe("42");
		expect(await renderOrdered("{{true}}|{{false}}", null)).toBe("true|false");
	});

	test("comments contribute nothing but their trimming", async () => {
		expect(await renderOrdered("a{{/* note */}}b", null)).toBe("ab");
		expect(await renderOrdered("a\n{{- /* note */ -}}\nb", null)).toBe("ab");
	});

	test("whitespace trimming", async () => {
		expect(await renderOrdered("a  {{- 1 -}}  b", null)).toBe("a1b");
		expect(await renderOrdered("a\n{{ 1 }}\nb", null)).toBe("a\n1\nb");
	});
});

describe("control flow", () => {
	test("if, else if, else close on one end", async () => {
		const src =
			'{{if eq . "a"}}A{{else if eq . "b"}}B{{else}}C{{end}}';
		expect(await renderOrdered(src, "a")).toBe("A");
		expect(await renderOrdered(src, "b")).toBe("B");
		expect(await renderOrdered(src, "z")).toBe("C");
	});

	test("Go's truth", () => {
		for (const value of [false, 0, "", null, undefined, [], {}]) {
			expect(truthy(value)).toBe(false);
		}
		for (const value of [true, 1, "x", [0], { a: 1 }]) {
			expect(truthy(value)).toBe(true);
		}
	});

	test("range over a list, with an index variable", async () => {
		expect(
			await renderOrdered("{{range $i, $v := .}}{{$i}}={{$v}};{{end}}", [
				"a",
				"b",
			]),
		).toBe("0=a;1=b;");
	});

	test("range over a map takes its keys in order", async () => {
		expect(
			await renderOrdered("{{range $k, $v := .}}{{$k}}{{$v}}{{end}}", {
				b: 2,
				a: 1,
			}),
		).toBe("a1b2");
	});

	test("range has an else for an empty list", async () => {
		expect(await renderOrdered("{{range .}}x{{else}}none{{end}}", [])).toBe(
			"none",
		);
	});

	test("with rebinds the dot", async () => {
		expect(
			await renderOrdered("{{with .A}}{{.B}}{{else}}no{{end}}", {
				A: { B: "y" },
			}),
		).toBe("y");
		expect(await renderOrdered("{{with .A}}x{{else}}no{{end}}", {})).toBe("no");
	});
});

describe("variables", () => {
	test("a declaration prints nothing and is readable after", async () => {
		expect(await renderOrdered('{{$x := "v"}}{{$x}}', null)).toBe("v");
	});

	test("assignment reaches a variable declared outside a range", async () => {
		// This is what lets `cli.tmpl` count alerts across every file.
		const src = "{{$n := 0}}{{range .}}{{$n = add1 $n}}{{end}}{{$n}}";
		expect(await renderOrdered(src, [1, 1, 1])).toBe("3");
	});

	test("a declaration inside a range does not leak out", async () => {
		const src = '{{$n := "outer"}}{{range .}}{{$n := "inner"}}{{end}}{{$n}}';
		expect(await renderOrdered(src, [1])).toBe("outer");
	});
});

describe("pipelines", () => {
	test("the value flows into the last argument", async () => {
		expect(await renderOrdered('{{"x" | printf "<%s>"}}', null)).toBe("<x>");
		expect(await renderOrdered("{{. | int | plural \"file\" \"files\"}}", 1)).toBe(
			"file",
		);
		expect(await renderOrdered("{{. | int | plural \"file\" \"files\"}}", 2)).toBe(
			"files",
		);
	});

	test("parentheses group a sub-expression", async () => {
		expect(
			await renderOrdered(
				'{{trimPrefix "," ((splitList " " "a b") | join ",")}}',
				null,
			),
		).toBe("a,b");
	});

	test("a pipeline into a non-function is an error", async () => {
		await expect(renderOrdered('{{"a" "b"}}', null)).rejects.toThrow(
			"non-function",
		);
	});

	test("an unknown function is an error", async () => {
		await expect(renderOrdered("{{nope .}}", null)).rejects.toThrow(
			'function "nope" not defined',
		);
	});
});

describe("builtins", () => {
	test("index reaches into a list and a map", async () => {
		expect(await renderOrdered("{{index .Span 0}}", { Span: [7, 9] })).toBe("7");
		expect(await renderOrdered('{{index . "a"}}', { a: "v" })).toBe("v");
	});

	test("printf", () => {
		expect(sprintf("%d:%d", [3, 1])).toBe("3:1");
		expect(sprintf("%s-%v", ["a", 2])).toBe("a-2");
		expect(sprintf("%4d|", [7])).toBe("   7|");
		expect(sprintf("%-4d|", [7])).toBe("7   |");
		expect(sprintf("%.2f", [1.239])).toBe("1.24");
		expect(sprintf("%c", [65])).toBe("A");
		expect(sprintf("100%%", [])).toBe("100%");
	});

	test("eq, ne and the orderings", async () => {
		expect(await renderOrdered("{{if eq 1 1}}y{{end}}", null)).toBe("y");
		expect(await renderOrdered("{{if ne 1 2}}y{{end}}", null)).toBe("y");
		expect(await renderOrdered("{{if lt 1 2}}y{{end}}", null)).toBe("y");
		expect(await renderOrdered("{{if and 1 2}}y{{end}}", null)).toBe("y");
		expect(await renderOrdered("{{if not 0}}y{{end}}", null)).toBe("y");
		expect(await renderOrdered("{{len .}}", [1, 2, 3])).toBe("3");
	});
});

describe("the Sprig subset", () => {
	test("strings", () => {
		expect(FUNCS.indent?.(1, "a\nb")).toBe(" a\n b");
		expect(FUNCS.trimPrefix?.(",", ",a")).toBe("a");
		expect(FUNCS.cat?.(null, "a", "b")).toBe("a b");
		expect(FUNCS.splitList?.(" ", "a b")).toEqual(["a", "b"]);
		expect(FUNCS.join?.(",", ["a", "b"])).toBe("a,b");
		expect(FUNCS.jsonEscape?.('a "b"')).toBe('a \\"b\\"');
	});

	test("numbers", () => {
		expect(FUNCS.add1?.(2)).toBe(3);
		expect(FUNCS.int?.("3.7")).toBe(3);
		expect(FUNCS.plural?.("file", "files", 1)).toBe("file");
	});

	test("a dict is shared, which is what collate.tmpl relies on", () => {
		const d = FUNCS.dict?.();
		FUNCS.set?.(d, "k", "v");
		expect(FUNCS.get?.(d, "k")).toBe("v");
		expect(FUNCS.get?.(d, "missing")).toBe("");
		expect(FUNCS.keys?.(d)).toEqual(["k"]);
	});

	test("toStrings coerces a list for a table row", () => {
		expect(FUNCS.toStrings?.(FUNCS.list?.("a", 1, null))).toEqual(["a", "1", ""]);
	});
});

// --- Vale's own templates -------------------------------------------------

const DATA = {
	Files: [
		{
			Path: "test.md",
			Alerts: [
				{
					Line: 3,
					Span: [1, 4],
					Check: "vale.Annotations",
					Severity: "suggestion",
					Message: "'NOTE' left in text",
					Link: "",
				},
				{
					Line: 5,
					Span: [2, 8],
					Check: "T.Swap",
					Severity: "error",
					Message: "Use 'use'.",
					Link: "https://vale.sh",
				},
			],
		},
	],
	LintedTotal: 1,
};

const LINE_TMPL = `{{range .Files}}
{{- $path := .Path -}}
{{- range .Alerts -}}
{{$path}}:{{.Line}}:{{index .Span 0}}:{{.Check}}:{{.Severity}}:{{.Message}}
{{end -}}
{{end -}}
`;

const CLI_TMPL = `{{- /* Keep track of our various counts */ -}}

{{- $e := 0 -}}
{{- $w := 0 -}}
{{- $s := 0 -}}
{{- $f := 0 -}}

{{- /* Range over the linted files */ -}}

{{- range .Files}}
{{$table := newTable true}}

{{- $f = add1 $f -}}
{{- .Path | underline | indent 1 -}}

{{- /* Range over the file's alerts */ -}}

{{- range .Alerts -}}

{{- $error := "" -}}
{{- if eq .Severity "error" -}}
    {{- $error = .Severity | red -}}
    {{- $e = add1 $e  -}}
{{- else if eq .Severity "warning" -}}
    {{- $error = .Severity | yellow -}}
    {{- $w = add1 $w -}}
{{- else -}}
    {{- $error = .Severity | blue -}}
    {{- $s = add1 $s -}}
{{- end}}

{{- $loc := printf "%d:%d" .Line (index .Span 0) -}}
{{- $row := list $loc $error .Message .Check .Link | toStrings -}}

{{- $table = addRow $table $row -}}
{{end -}}

{{- $table = renderTable $table -}}
{{end}}
{{- $e}} {{"errors" | red}}, {{$w}} {{"warnings" | yellow}} and {{$s}} {{"suggestions" | blue}} in {{$f}} {{$f | int | plural "file" "files"}}.
`;

describe("Vale's own templates", () => {
	test("line.tmpl", async () => {
		expect(await renderOrdered(LINE_TMPL, DATA)).toBe(
			"test.md:3:1:vale.Annotations:suggestion:'NOTE' left in text\n" +
				"test.md:5:2:T.Swap:error:Use 'use'.\n",
		);
	});

	test("cli.tmpl renders its table and its summary", async () => {
		const out = await renderOrdered(CLI_TMPL, DATA);

		// The path, then the table the funcs printed, then the counts.
		expect(out).toContain(" test.md");
		expect(out).toContain(
			" 3:1  suggestion  'NOTE' left in text  vale.Annotations                  \n",
		);
		expect(out).toContain(
			" 5:2  error       Use 'use'.           T.Swap            https://vale.sh \n",
		);
		expect(out.trimEnd().endsWith("1 errors, 0 warnings and 1 suggestions in 1 file.")).toBe(
			true,
		);
	});
});
