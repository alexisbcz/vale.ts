import { readFileSync } from "node:fs";
import { getComments, getLanguageFromExt, initCode } from "../../src/code/index.ts";
await initCode();
const src = readFileSync("tests/compat/.cache/testdata/fixtures/formats/test.cs", "utf8");
for (const c of getComments(src, getLanguageFromExt(".cs"))) {
  console.log(`${c.line}:${c.offset} ${c.scope} ${JSON.stringify(c.text)}`);
}
