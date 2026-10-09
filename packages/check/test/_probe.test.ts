import { test } from "bun:test";
import { compile } from "css-select";

test("probe", () => {
	for (const s of [
		'section:has(> h2:contains("A & B"))',
		"h2, h3",
		"section:has(> h2, > h3)",
		"section:has(+ section)",
		"section:has(~ section)",
		"section:not(:has(> h2, > h3))",
		"section:has(> :not(:not(h2, h3)):contains('i'))",
		"h2 + p",
		"ul:not(p + ul)",
		"section:has( >h2)",
		"h2:contains(':is(')",
		"h2:has(",
		":is(",
		":is(h2",
		"section:haschild(h2)",
		"section:has(>)",
		":not(:not(h2, h3))",
	]) {
		let err = "";
		try {
			compile(s);
		} catch (e) {
			err = (e as Error).message;
		}
		console.log(JSON.stringify(s), "=>", err || "ok");
	}
});
