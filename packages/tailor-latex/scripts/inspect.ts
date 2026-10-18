// Manual check: node --experimental-strip-types scripts/inspect.ts <resume-dir> [main.tex]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderDoc } from "@resume-studio/tailor";
import { parseLatex } from "../src/index.ts";

const dir = process.argv[2];
const main = process.argv[3] ?? "main.tex";
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else if (/\.(tex|cls|sty)$/.test(n)) files[relative(dir, f)] = readFileSync(f, "utf8");
  }
};
walk(dir);
const p = parseLatex({ main, files });
console.log(renderDoc(p.doc));
console.log(`\n-- ${p.lists.size} lists, ${p.bullets.size} bullets, ${p.skills.size} skills lines, ${p.paragraphs.size} paragraphs, headline: ${p.doc.headline?.text ?? "none"}`);
