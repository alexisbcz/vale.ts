/**
 * The three built-in output formats, against a hand-built list of alerts.
 *
 * `line` and `JSON` are asserted byte-for-byte: a script parses them, so the
 * bytes are the interface. `CLI` is asserted on its layout, which is
 * `tablewriter`'s borderless rendition down to the trailing space.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { printVerboseAlerts } from "../src/color.ts";
import { printJSONAlerts, printJSONAlertsWithCounts } from "../src/json.ts";
import { printLineAlerts } from "../src/line.ts";
import { capture } from "../src/out.ts";
import { setTerminal } from "../src/tty.ts";
import { alert, file } from "./helpers.ts";

beforeEach(() => {
	setTerminal(false, false);
});

const files = [
	file("doc.md", [
		alert({
			line: 3,
			span: [1, 4],
			severity: "suggestion",
			check: "vale.Annotations",
			message: "'NOTE' left in text",
			match: "NOTE",
		}),
		alert({
			line: 1,
			span: [5, 11],
			severity: "error",
			check: "T.Swap",
			message: "Use 'use' instead of 'utilize'.",
			match: "utilize",
			action: { name: "replace", params: ["use"] },
			suggestions: ["use"],
		}),
		alert({
			line: 3,
			span: [10, 13],
			severity: "warning",
			check: "T.Weasel",
			message: "'very' is a weasel word!",
			match: "very",
		}),
	]),
];

describe("--output=line", () => {
	test("one alert per line, sorted by position", async () => {
		const out = await capture(() => {
			printLineAlerts(files, false);
		});
		expect(out.out).toBe(
			"doc.md:1:5:T.Swap:Use 'use' instead of 'utilize'.\n" +
				"doc.md:3:1:vale.Annotations:'NOTE' left in text\n" +
				"doc.md:3:10:T.Weasel:'very' is a weasel word!\n",
		);
	});

	test("an error in the run is reported back", async () => {
		let hasErrors = false;
		await capture(() => {
			hasErrors = printLineAlerts(files, false);
		});
		expect(hasErrors).toBe(true);

		await capture(() => {
			hasErrors = printLineAlerts(
				[file("a.md", [alert({ severity: "warning" })])],
				false,
			);
		});
		expect(hasErrors).toBe(false);
	});
});

describe("--output=JSON", () => {
	test("Go's field names, order and escaping", async () => {
		const out = await capture(() => {
			printJSONAlerts([
				file("doc.md", [
					alert({
						line: 1,
						span: [5, 11],
						severity: "error",
						check: "T.Swap",
						message: "Use '<b>' & \"this\".",
						match: "utilize",
						action: { name: "replace", params: ["use"] },
						suggestions: ["use"],
					}),
				]),
			]);
		});

		expect(out.out).toBe(`{
  "doc.md": [
    {
      "Action": {
        "Name": "replace",
        "Params": [
          "use"
        ]
      },
      "Suggestions": [
        "use"
      ],
      "Span": [
        5,
        11
      ],
      "Check": "T.Swap",
      "Description": "",
      "Link": "",
      "Message": "Use '\\u003cb\\u003e' \\u0026 \\"this\\".",
      "Severity": "error",
      "Match": "utilize",
      "Line": 1
    }
  ]
}
`);
	});

	test("an action with no arguments has a null Params", async () => {
		const out = await capture(() => {
			printJSONAlerts([file("a.md", [alert({})])]);
		});
		expect(out.out).toContain('"Params": null');
		expect(out.out).toContain('"Suggestions": []');
	});

	test("groups are left out when the token captured nothing", async () => {
		const without = await capture(() => {
			printJSONAlerts([file("a.md", [alert({})])]);
		});
		expect(without.out).not.toContain("Groups");

		const with_ = await capture(() => {
			printJSONAlerts([file("a.md", [alert({ groups: ["x"] })])]);
		});
		expect(with_.out).toContain('"Groups": [');
	});

	test("a clean run is an empty object", async () => {
		const out = await capture(() => {
			printJSONAlerts([file("a.md", [])]);
		});
		expect(out.out).toBe("{}\n");
	});

	test("paths are sorted, as a Go map's keys are", async () => {
		const out = await capture(() => {
			printJSONAlerts([
				file("z.md", [alert({})]),
				file("a.md", [alert({})]),
			]);
		});
		expect(out.out.indexOf('"a.md"')).toBeLessThan(out.out.indexOf('"z.md"'));
	});

	test("--counts adds a per-check tally with its zeros", async () => {
		const out = await capture(() => {
			printJSONAlertsWithCounts([file("doc.md", [alert({ check: "T.Live" })])], {
				"T.Live": 1,
				"T.Dead": 0,
			});
		});
		expect(out.out).toContain(`  "counts": {
    "T.Dead": 0,
    "T.Live": 1
  }`);
		expect(out.out.startsWith('{\n  "files": {')).toBe(true);
	});
});

describe("--output=CLI", () => {
	test("a borderless table per file, then the summary", async () => {
		const out = await capture(() => {
			printVerboseAlerts(files);
		});

		expect(out.out).toBe(
			"\n doc.md\n" +
				" 1:5   error       Use 'use' instead of 'utilize'.  T.Swap           \n" +
				" 3:1   suggestion  'NOTE' left in text              vale.Annotations \n" +
				" 3:10  warning     'very' is a weasel word!         T.Weasel         \n" +
				"\n" +
				"✖ 1 error, 1 warning and 1 suggestion in 1 file.\n",
		);
	});

	test("a clean run is the summary alone, with a check mark", async () => {
		const out = await capture(() => {
			printVerboseAlerts([file("a.md", [])]);
		});
		expect(out.out).toBe(
			"✔ 0 errors, 0 warnings and 0 suggestions in 1 file.\n",
		);
	});

	test("one stdin document is named rather than counted", async () => {
		const out = await capture(() => {
			printVerboseAlerts([file("stdin.md", [])]);
		});
		expect(out.out).toContain("in stdin.");
	});

	test("several files are counted", async () => {
		const out = await capture(() => {
			printVerboseAlerts([file("a.md", []), file("b.md", [])]);
		});
		expect(out.out).toContain("in 2 files.");
	});

	test("color is applied when the terminal wants it", async () => {
		setTerminal(true, false);
		const out = await capture(() => {
			printVerboseAlerts([file("a.md", [alert({ severity: "error" })])]);
		});
		expect(out.out).toContain("\u001b[31merror\u001b[0m");
		expect(out.out).toContain("\u001b[4ma.md\u001b[0m");
	});
});
