/**
 * Reading a Jupyter notebook, cell by cell.
 *
 * A Markdown cell is read as Markdown and a code cell as the kernel's
 * language, so that its comments are the prose. Raw cells and outputs are
 * neither, and are skipped.
 *
 * The cells themselves are parsed in `@vale-ts/core` (`notebook.ts`), which
 * knows where each one's source sits in the file; each cell is linted in the
 * file's place and its alerts are then moved back to where its source is.
 *
 * A view on the file takes precedence, which the linter decides before a
 * reader is chosen -- anyone who wants a different reading writes one.
 */

import type { File } from "@vale-ts/core";
import { newE100, parseNotebook } from "@vale-ts/core";
import { placeAlerts } from "./scoped.ts";

/** What a notebook reader needs from the linter. */
export interface NotebookHost {
	/** Reads the file as the named markup. */
	readAs(f: File, format: string): void;
	/** Reads the file's text as code in the given language. */
	readAsCode(f: File, ext: string): void;
}

/** Reads a `.ipynb` file. */
export function lintNotebook(host: NotebookHost, f: File): void {
	let cells: ReturnType<typeof parseNotebook>;
	try {
		cells = parseNotebook(f);
	} catch (err) {
		throw newE100(f.path, err);
	}

	const wholeFile = f.content;
	const realExt = f.realExt;
	const normedExt = f.normedExt;
	let last = 0;

	try {
		for (const cell of cells) {
			if (cell.type === "markdown") {
				f.setText(cell.value.text);
				f.setNormedExt("md");
				host.readAs(f, "md");
			} else if (cell.type === "code" && cell.lang !== "") {
				f.setText(cell.value.text);
				host.readAsCode(f, cell.lang);
			} else {
				continue;
			}

			const size = f.alerts.length;
			if (size !== last) {
				placeAlerts(f.alerts, last, cell.value, f.content);
				last = size;
			}
		}
	} finally {
		f.setText(wholeFile);
		f.realExt = realExt;
		f.normedExt = normedExt;
	}
}
