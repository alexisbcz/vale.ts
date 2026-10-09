// Ad-hoc: run one e2e suite's cases through both binaries and compare.
import { parse } from "yaml";
import { readFileSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import * as path from "node:path";

const TD = "/tmp/claude-1000/-home-alex-Work-vale-ts/129820bf-a813-4707-a2b2-fd8761eaef80/scratchpad/vale-go/testdata";
const REF = "/home/alex/Work/vale.ts/tests/compat/.cache/bin/vale";
const TS = "/home/alex/Work/vale.ts/packages/cli/src/main.ts";
const SHARED = ["--output=line", "--sort", "--normalize", "--relative", "--no-global"];
const WORK = "/tmp/claude-1000/-home-alex-Work-vale-ts/129820bf-a813-4707-a2b2-fd8761eaef80/scratchpad/sweepwork";

function splitArgs(a: unknown): string[] {
	if (Array.isArray(a)) return a.map(String);
	if (typeof a === "string") return a.trim() === "" ? [] : a.split(/\s+/);
	return [];
}

async function main() {
	const suiteFile = process.argv[2]!;
	const suite = parse(readFileSync(path.join(TD, "e2e", suiteFile), "utf8")) as any;
	let ok = 0, bad = 0;

	for (const c of suite.cases ?? []) {
		const dir = c.dir ?? suite.dir ?? "";
		let base: string;
		if (dir.endsWith("/*")) base = path.join(TD, dir.slice(0, -2), c.name);
		else base = path.resolve(path.join(TD, suite.dir ?? ""), dir ? path.join("..", "..", "x", "..", "..", dir) : ".");
		// Simpler: resolve dir relative to testdata, and a case `dir` relative to the suite dir.
		base = c.dir
			? path.resolve(path.join(TD, suite.dir ?? ""), c.dir)
			: path.join(TD, suite.dir ?? "");
		if ((suite.dir ?? "").endsWith("/*")) base = path.join(TD, (suite.dir as string).slice(0, -2), c.dir ?? c.name);

		const files = { ...(suite.files ?? {}), ...(c.files ?? {}) };
		const roots: string[] = [];
		for (const which of ["a", "b"]) {
			const root = path.join(WORK, which);
			rmSync(root, { recursive: true, force: true });
			mkdirSync(root, { recursive: true });
			if (Object.keys(files).length > 0) {
				for (const [name, body] of Object.entries(files)) {
					const p = path.join(root, name);
					mkdirSync(path.dirname(p), { recursive: true });
					writeFileSync(p, String(body));
				}
			} else if (existsSync(base)) {
				cpSync(base, root, { recursive: true });
			}
			roots.push(root);
		}

		const args = [...SHARED, ...splitArgs(c.args)];
		const run = async (cmd: string[], cwd: string) => {
			const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: c.stdin ? Bun.file(path.join(cwd, c.stdin)) : "ignore" });
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const code = await proc.exited;
			return { text: out + err, code };
		};

		if (c.sync) {
			await run([REF, "sync"], roots[0]!);
			await run(["bun", TS, "sync"], roots[1]!);
		}

		const a = await run([REF, ...args], roots[0]!);
		const b = await run(["bun", TS, ...args], roots[1]!);

		const norm = (s: string, r: string) => s.replaceAll(r, "DIR");
		const at = norm(a.text, roots[0]!), bt = norm(b.text, roots[1]!);

		if (at === bt && a.code === b.code) { ok++; continue; }
		bad++;
		console.log(`\n--- ${suite.name}/${c.name}  (ref=${a.code} ts=${b.code})`);
		if (at !== bt) {
			console.log("REF:", JSON.stringify(at.slice(0, 400)));
			console.log("TS :", JSON.stringify(bt.slice(0, 400)));
		}
	}
	console.log(`\n${suiteFile}: ${ok} match, ${bad} differ`);
}
await main();
