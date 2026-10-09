/**
 * The package library: the index that lets `Packages = write-good` name a
 * style without naming a URL.
 */

import type { Style } from "./api.ts";
import { fetchJSON } from "./util.ts";

const LIBRARY =
	"https://raw.githubusercontent.com/vale-cli/packages/master/library.json";

/** Reads the library index, or an empty list when it cannot be read. */
export async function getLibrary(): Promise<Style[]> {
	try {
		const body = await fetchJSON(LIBRARY);
		const parsed = JSON.parse(body);
		return Array.isArray(parsed) ? (parsed as Style[]) : [];
	} catch {
		return [];
	}
}

/** The URL the library has for `name`, or `""`. */
export async function inLibrary(name: string): Promise<string> {
	for (const entry of await getLibrary()) {
		if (entry.name === name) return entry.url;
	}
	return "";
}
