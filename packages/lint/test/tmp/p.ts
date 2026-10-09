import { readFileSync } from "node:fs";
import { getComments, getLanguageFromExt, initCode } from "../../src/code/index.ts";
import { commentPadding } from "../../src/fragment.ts";
import { findLine } from "../../src/util.ts";
await initCode();
const src = readFileSync("tests/compat/.cache/testdata/fixtures/formats/test.proto", "utf8");
const lang = getLanguageFromExt(".proto");
for (const c of getComments(src, lang)) {
  if (!c.text.includes("XXX")) continue;
  console.log(c);
  console.log("padding line1:", commentPadding(c, 1, findLine(c.source, 1), lang));
}
