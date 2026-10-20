import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { markupToLatex, latexToMarkup } from "./convert.ts";
import { applyLatex, latexAdapter, parseLatex } from "./latex.ts";

const classic = readFileSync(new URL("./fixtures/classic.tex", import.meta.url), "utf8");
const src = (main: string, files: Record<string, string> = {}) => ({ main: "main.tex", files: { "main.tex": main, ...files } });

test("markup ⇄ LaTeX", () => {
  assert.equal(
    latexToMarkup(String.raw`Cut p99 latency \textbf{75\%} (480\,ms$\to$120\,ms) for \emph{all} \href{https://x.io}{users} -- fast`),
    "Cut p99 latency **75%** (480 ms→120 ms) for *all* [users](https://x.io) – fast",
  );
  assert.equal(markupToLatex("Cut **75%** of $2B & #1 C# _x_ – done → ok"), String.raw`Cut \textbf{75\%} of \$2B \& \#1 C\# \_x\_ -- done $\rightarrow$ ok`);
  assert.equal(markupToLatex('Said "hi" [site](https://a.b/c%20d)'), "Said ``hi'' \\href{https://a.b/c\\%20d}{site}");
});

test("parse the Classic template", () => {
  const { doc } = parseLatex(src(classic));
  assert.equal(doc.headline?.text, "Senior Software Engineer");
  assert.deepEqual(
    doc.sections.map((s) => s.kind),
    ["summary", "experience", "projects", "education", "skills"],
  );
  assert.equal(doc.sections[1].lists[0].bullets.length, 4);
  assert.match(doc.sections[1].lists[0].heading, /Foo Payments/);
  assert.deepEqual(
    doc.sections[4].skills.map((k) => k.label),
    ["Languages", "Infrastructure", "Data", "Practices"],
  );
  assert.ok(doc.sections[0].paragraph?.text.startsWith("Backend engineer with 8 years"));
});

test("no edits: the source is returned unchanged", () => {
  const { source } = applyLatex(src(classic), []);
  assert.equal(source.files["main.tex"], classic);
});

test("every edit kind, and nothing else changes", () => {
  const before = src(classic);
  const { doc } = parseLatex(before);
  const [b1, b2, , b4] = doc.sections[1].lists[0].bullets.map((b) => b.id);
  const l2 = doc.sections[1].lists[1];
  const { source } = applyLatex(before, [
    { id: "e1", change: { op: "rewrite_bullet", target: b1, text: "Cut p99 checkout latency **75%** (480 ms → 120 ms) with **Apache Kafka** consumers." } },
    { id: "e2", change: { op: "remove_bullet", target: b4 } },
    { id: "e3", change: { op: "add_bullet", target: doc.sections[1].lists[0].id, after: b2, text: "Wrote the on-call runbook used by 9 teams." } },
    { id: "e4", change: { op: "reorder_bullets", target: l2.id, order: [...l2.bullets.map((b) => b.id)].reverse() } },
    { id: "e5", change: { op: "rewrite_skills", target: doc.sections[4].skills[0].id, text: "Languages: Go, SQL, Python" } },
    { id: "e6", change: { op: "set_headline", target: "h1", text: "Staff Backend Engineer" } },
    { id: "e7", change: { op: "rewrite_paragraph", target: doc.sections[0].paragraph!.id, text: "Backend engineer focused on **payments** at scale." } },
  ]);
  const out = source.files["main.tex"];
  assert.match(out, /\\item Cut p99 checkout latency \\textbf\{75\\%\} \(480 ms \$\\rightarrow\$ 120 ms\) with \\textbf\{Apache Kafka\} consumers\./);
  assert.doesNotMatch(out, /Introduced SLOs and error budgets/);
  assert.match(out, /cost by 32\\%\.\n {2}\\item Wrote the on-call runbook used by 9 teams\.\n {2}\\item Designed/);
  assert.match(out, /\\textbf\{Languages:\} Go, SQL, Python\\par/);
  assert.match(out, /Staff Backend Engineer\\sep \\mbox\{San Francisco, CA\}/);
  assert.match(out, /\\section\{Summary\}\nBackend engineer focused on \\textbf\{payments\} at scale\.\n\n%/);
  // The reordered list: Mentored first, Built last.
  const second = out.slice(out.indexOf("Bar Analytics"));
  assert.ok(second.indexOf("Mentored") < second.indexOf("Reduced") && second.indexOf("Reduced") < second.indexOf("Built a streaming"));
  // Everything outside the edited spans is identical.
  assert.equal(out.slice(0, out.indexOf("\\begin{document}")), classic.slice(0, classic.indexOf("\\begin{document}")));
  const block = (t: string) => t.slice(t.indexOf("% ---- Projects"), t.indexOf("% ---- Skills"));
  assert.equal(block(out), block(classic));
  assert.ok(out.endsWith("\\textbf{Practices:} Distributed systems, API design, observability (Prometheus, Grafana), SRE\n\n\\end{document}\n"));
  // And the result parses again with the edits visible.
  const again = parseLatex(source).doc;
  assert.equal(again.sections[1].lists[0].bullets.length, 4);
  assert.equal(again.headline?.text, "Staff Backend Engineer");
});

test("macro bullets (Jake's \\resumeItem) and custom list macros", () => {
  const main = String.raw`\documentclass{article}
\newcommand{\resumeItem}[1]{\item\small{{#1 \vspace{-2pt}}}}
\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}
\begin{document}
\section{Experience}
\textbf{Research Assistant} \hfill June 2020 -- Present
      \resumeItemListStart
        \resumeItem{Developed a REST API using FastAPI and PostgreSQL}
        \resumeItem{Explored ways to visualize GitHub collaboration}
      \resumeItemListEnd
\end{document}`;
  const { doc } = parseLatex(src(main));
  const bullets = doc.sections[0].lists[0].bullets;
  assert.deepEqual(
    bullets.map((b) => b.text),
    ["Developed a REST API using FastAPI and PostgreSQL", "Explored ways to visualize GitHub collaboration"],
  );
  const { source } = applyLatex(src(main), [
    { id: "e1", change: { op: "rewrite_bullet", target: bullets[0].id, text: "Built a **REST API** in **FastAPI** on **PostgreSQL**" } },
    { id: "e2", change: { op: "add_bullet", target: doc.sections[0].lists[0].id, after: null, text: "Led the data pipeline" } },
  ]);
  assert.match(
    source.files["main.tex"],
    /\\resumeItemListStart\n {8}\\resumeItem\{Led the data pipeline\}\n {8}\\resumeItem\{Built a \\textbf\{REST API\} in \\textbf\{FastAPI\} on \\textbf\{PostgreSQL\}\}\n {8}\\resumeItem\{Explored/,
  );
});

test("bullets in \\input files are edited in their own file", () => {
  const main = "\\documentclass{article}\n\\begin{document}\n\\input{sections/exp}\n\\end{document}\n";
  const exp = "\\section{Experience}\nAcme\n\\begin{itemize}\n  \\item Wrote Go services % comment stays\n  \\item Ran Kafka\n\\end{itemize}\n";
  const s = src(main, { "sections/exp.tex": exp });
  const { doc } = parseLatex(s);
  const [b1, b2] = doc.sections[0].lists[0].bullets;
  assert.equal(b1.text, "Wrote Go services");
  const { source, locations } = applyLatex(s, [{ id: "e1", change: { op: "rewrite_bullet", target: b2.id, text: "Ran **Kafka** at 50% & more" } }]);
  assert.equal(source.files["main.tex"], main);
  assert.equal(source.files["sections/exp.tex"], exp.replace("\\item Ran Kafka", "\\item Ran \\textbf{Kafka} at 50\\% \\& more"));
  // List edits rebuild the list, so they map to the list's lines.
  assert.deepEqual(locations.get("e1"), { file: "sections/exp.tex", startLine: 4, endLine: 6 });
});

test("the adapter maps a build error line back to the edit", () => {
  const s = src(classic);
  const { doc } = parseLatex(s);
  const draft = latexAdapter.apply(s, doc, [{ id: "e1", change: { op: "set_headline", target: "h1", text: "Backend Engineer" } }]) as ReturnType<
    typeof applyLatex
  >["source"];
  const line = draft.files["main.tex"].split("\n").findIndex((l) => l.includes("Backend Engineer\\sep")) + 1;
  assert.equal(latexAdapter.editAt(draft, { file: "main.tex", line }), "e1");
  assert.equal(latexAdapter.editAt(draft, { file: "main.tex", line: 1 }), null);
});
