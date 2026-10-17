// The evaluation data: resumes (LaTeX folders), job postings (Markdown with front matter) and the cases
// that pair them. Layout of a data folder:
//   resumes/<id>/main.tex (+ any other files the resume needs)
//   jds/<id>.md           front matter (company, role, level, family, location, url) + the posting's text
//   cases.json            [{ "resume": "<id>", "jd": "<id>" }, …]   (optional: default is every resume × every JD)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { JobInput, Seniority, SourceFiles } from "@resume-studio/tailor";

export interface Posting {
  id: string;
  company: string;
  role: string;
  level?: string;
  family?: string;
  location?: string;
  url?: string;
  description: string;
}

export interface Resume {
  id: string;
  dir: string;
  source: SourceFiles;
  /**
   * The candidate's full, true history (history.md next to the resume): what the resume leaves out, and
   * what they haven't done. A simulated candidate answers the engine's questions from it, and only it.
   */
  history?: string;
}

export interface Case {
  /** "<resume>__<jd>" */
  id: string;
  resume: Resume;
  posting: Posting;
}

/** Splits "---\nkey: value\n---\nbody" into fields and body. Values are plain strings. */
export function parseFrontMatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, body: m[2].trim() };
}

const LEVELS: Record<string, Seniority> = { intern: "intern", junior: "junior", "new-grad": "junior", mid: "mid", senior: "senior", staff: "staff", principal: "principal" };

export function jobInput(p: Posting): JobInput {
  return { company: p.company, role: p.role, seniority: p.level ? LEVELS[p.level] : undefined, description: p.description, location: p.location, link: p.url };
}

export function loadPostings(dataDir: string): Posting[] {
  const dir = join(dataDir, "jds");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
    .sort()
    .map((f) => {
      const { fields, body } = parseFrontMatter(readFileSync(join(dir, f), "utf8"));
      // A posting can be pasted as it came (no front matter): the engine reads company and title from it.
      if (body.length < 200) throw new Error(`${f}: needs the posting's text`);
      return { id: f.replace(/\.(md|txt)$/, ""), company: fields.company ?? "", role: fields.role ?? "", level: fields.level, family: fields.family, location: fields.location, url: fields.url, description: body };
    });
}

export function loadResumes(dataDir: string): Resume[] {
  const root = join(dataDir, "resumes");
  return readdirSync(root)
    .filter((d) => statSync(join(root, d)).isDirectory())
    .sort()
    .map((id) => {
      const dir = join(root, id);
      const files: Record<string, string> = {};
      const walk = (d: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(tex|cls|sty|bib)$/.test(n)) files[relative(dir, p)] = readFileSync(p, "utf8");
        }
      };
      walk(dir);
      if (!files["main.tex"]) throw new Error(`resumes/${id}: no main.tex`);
      const historyFile = join(dir, "history.md");
      return { id, dir, source: { main: "main.tex", files }, history: existsSync(historyFile) ? readFileSync(historyFile, "utf8") : undefined };
    });
}

export function loadCases(dataDir: string): Case[] {
  const postings = loadPostings(dataDir);
  const resumes = loadResumes(dataDir);
  const file = join(dataDir, "cases.json");
  const pairs: { resume: string; jd: string }[] = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { resume: string; jd: string }[])
    : resumes.flatMap((r) => postings.map((p) => ({ resume: r.id, jd: p.id })));
  return pairs.map(({ resume, jd }) => {
    const r = resumes.find((x) => x.id === resume);
    const p = postings.find((x) => x.id === jd);
    if (!r) throw new Error(`cases.json: no resume "${resume}"`);
    if (!p) throw new Error(`cases.json: no job posting "${jd}"`);
    return { id: `${resume}__${jd}`, resume: r, posting: p };
  });
}
