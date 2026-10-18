// Manual check: applies a fixed set of edits to a resume and writes the result to an output folder.
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { applyLatex, parseLatex } from "../src/index.ts";

const [dir, main, out] = process.argv.slice(2);
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else if (/\.(tex|cls|sty)$/.test(n)) files[relative(dir, f)] = readFileSync(f, "utf8");
  }
};
walk(dir);
const { doc } = parseLatex({ main, files });
const exp = doc.sections.find((s) => s.lists.length)!;
const l = exp.lists[0];
const skills = doc.sections.find((s) => s.skills.length)?.skills[0];
const edits = [
  { id: "e1", change: { op: "rewrite_bullet" as const, target: l.bullets[0].id, text: "Cut failures **60%** & costs $2B → 50% with C# / C++ in \"prod\" — 100_000 jobs (~2x)" } },
  { id: "e2", change: { op: "remove_bullet" as const, target: l.bullets[l.bullets.length - 1].id } },
  { id: "e3", change: { op: "add_bullet" as const, target: l.id, after: l.bullets[0].id, text: "Added bullet with a [link](https://example.com/a_b%20c) and *italic*." } },
  ...(skills ? [{ id: "e4", change: { op: "rewrite_skills" as const, target: skills.id, text: "Go, TypeScript, Kubernetes" } }] : []),
  ...(doc.headline ? [{ id: "e5", change: { op: "set_headline" as const, target: doc.headline.id, text: "Backend Software Engineer" } }] : []),
];
const { source } = applyLatex({ main, files }, edits);
cpSync(dir, out, { recursive: true });
for (const [f, t] of Object.entries(source.files)) {
  mkdirSync(dirname(join(out, f)), { recursive: true });
  writeFileSync(join(out, f), t);
}
console.log(`applied ${edits.length} edits → ${out}`);
