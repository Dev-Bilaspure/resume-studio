// Deterministic checks of model-written edits, before any model judges them. Anything that fails a hard
// check (unknown target, broken markup, a number or technology the evidence doesn't contain) goes to
// repair; soft problems (length) are flagged for the reviewer.
import { docText } from "./doc.ts";
import { canonical, impliedBy, isSoftTerm, mentions, techTerms } from "./lexicon.ts";
import type { EditOutput } from "./prompts.ts";
import { markupProblems, plain, unsupportedNumbers } from "./text.ts";
import { evidenceFacts, type Edit, type EditOp, type EvidenceRef, type Fact, type JobProfile, type ResumeDoc, type TailorOptions } from "./types.ts";

const MAX_BULLET_CHARS = 230;
const MAX_HEADLINE_CHARS = 70;

export interface DocIndex {
  bullets: Map<string, { text: string; listId: string }>;
  lists: Map<string, { bulletIds: string[]; heading: string }>;
  skills: Map<string, string>;
  paragraphs: Map<string, string>;
  headline?: { id: string; text: string };
  facts: Map<string, Fact>;
  /** Topics the candidate said they haven't done: never evidence. */
  lacking: Set<string>;
  /** All the resume's text and facts: what "the candidate has" for skills lines. */
  allText: string;
  /** Every entry's heading (role, employer, dates): the experience a headline must be true to. */
  headings: string[];
}

export function indexDoc(doc: ResumeDoc, allFacts: Fact[]): DocIndex {
  const facts = evidenceFacts(allFacts);
  const bullets = new Map<string, { text: string; listId: string }>();
  const lists = new Map<string, { bulletIds: string[]; heading: string }>();
  const skills = new Map<string, string>();
  const paragraphs = new Map<string, string>();
  for (const s of doc.sections) {
    for (const l of s.lists) {
      lists.set(l.id, { bulletIds: l.bullets.map((b) => b.id), heading: l.heading });
      for (const b of l.bullets) bullets.set(b.id, { text: b.text, listId: l.id });
    }
    for (const k of s.skills) skills.set(k.id, `${k.label ? `${k.label}: ` : ""}${k.text}`);
    if (s.paragraph) paragraphs.set(s.paragraph.id, s.paragraph.text);
  }
  return {
    bullets,
    lists,
    skills,
    paragraphs,
    headline: doc.headline,
    facts: new Map(facts.map((f) => [f.id, f])),
    lacking: new Set(allFacts.filter((f) => f.kind === "lacks").map((f) => f.id)),
    headings: [...lists.values()].map((l) => l.heading).filter(Boolean),
    // From the structure as well as the adapter's plain text, so nothing on the resume is missed.
    allText: [docText(doc), doc.plainText, ...facts.map((f) => `${f.text} ${f.skills.join(", ")}`)].join("\n"),
  };
}

export function evidenceText(ix: DocIndex, ref: EvidenceRef): string | null {
  switch (ref.kind) {
    case "bullet":
      return ix.bullets.get(ref.id)?.text ?? null;
    case "fact": {
      const f = ix.facts.get(ref.id);
      return f ? `${f.text}${f.skills.length ? ` (${f.skills.join(", ")})` : ""}` : null;
    }
    case "skills":
      return ix.skills.get(ref.id) ?? null;
    case "paragraph":
      return ix.paragraphs.get(ref.id) ?? null;
    case "headline":
      return ix.headline?.id === ref.id ? ix.headline.text : null;
  }
}

/** The text an edit replaces (empty for additions). */
export function beforeText(ix: DocIndex, change: EditOp): string {
  switch (change.op) {
    case "rewrite_bullet":
    case "remove_bullet":
      return ix.bullets.get(change.target)?.text ?? "";
    case "rewrite_paragraph":
      return ix.paragraphs.get(change.target) ?? "";
    case "rewrite_skills":
      return ix.skills.get(change.target) ?? "";
    case "set_headline":
      return ix.headline?.text ?? "";
    default:
      return "";
  }
}

/**
 * The heading of the entry a bullet edit belongs to ("Webhook Delivery | Go, Kafka, Docker"): it's
 * evidence for that entry's bullets (the project is in Go even if no bullet says so).
 */
export function entryHeading(ix: DocIndex, change: EditOp): string {
  const listId = change.op === "rewrite_bullet" || change.op === "remove_bullet" ? ix.bullets.get(change.target)?.listId : change.op === "add_bullet" ? change.target : undefined;
  return listId ? (ix.lists.get(listId)?.heading ?? "") : "";
}

/** Model output → a typed edit, or the reason it isn't one. */
export function toEdit(o: EditOutput, id: string): Edit | string {
  const base = { id, reason: o.reason, requirements: o.requirements, evidence: o.evidence };
  const text = o.text?.trim() ?? "";
  switch (o.op) {
    case "rewrite_bullet":
    case "rewrite_paragraph":
    case "set_headline":
    case "rewrite_skills":
      if (!text) return `${o.op} without text`;
      return { ...base, change: { op: o.op, target: o.target, text } };
    case "remove_bullet":
      return { ...base, change: { op: "remove_bullet", target: o.target } };
    case "add_bullet":
      if (!text) return "add_bullet without text";
      return { ...base, change: { op: "add_bullet", target: o.target, after: o.after, text } };
    case "reorder_bullets":
      if (!o.order?.length) return "reorder_bullets without an order";
      return { ...base, change: { op: "reorder_bullets", target: o.target, order: o.order } };
  }
}

export interface CheckResult {
  /** Edits that passed (status ok or flagged). */
  passed: Edit[];
  /** Edits that need repair, with the reasons. */
  failed: { edit: Edit; issues: string[] }[];
}

/**
 * Structural and evidence checks for a batch of edits. Edits are considered in order; a later edit to a
 * target already edited is dropped (one change per target keeps review simple).
 */
export function checkEdits(edits: Edit[], ix: DocIndex, profile: JobProfile, opts: TailorOptions): CheckResult {
  const passed: Edit[] = [];
  const failed: { edit: Edit; issues: string[] }[] = [];
  const touched = new Set<string>();
  const removedPerList = new Map<string, number>();
  const jobTerms = profile.keywords.map((k) => ({ term: k.term, aliases: k.aliases }));

  for (const e of edits) {
    const c = e.change;
    const issues: string[] = [];
    const soft: string[] = [];

    // -- target and structure
    const key = `${c.op === "add_bullet" ? "add" : c.op === "reorder_bullets" ? "order" : "t"}:${c.target}:${c.op === "add_bullet" ? (c.after ?? "^") : ""}`;
    if (touched.has(key)) {
      issues.push("another edit already changes this target");
    }
    switch (c.op) {
      case "rewrite_bullet":
      case "remove_bullet":
        if (!ix.bullets.has(c.target)) issues.push(`unknown bullet ${c.target}`);
        break;
      case "add_bullet":
      case "reorder_bullets":
        if (!ix.lists.has(c.target)) issues.push(`unknown entry ${c.target}`);
        break;
      case "rewrite_paragraph":
        if (!ix.paragraphs.has(c.target)) issues.push(`unknown paragraph ${c.target}`);
        break;
      case "rewrite_skills":
        if (!ix.skills.has(c.target)) issues.push(`unknown skills line ${c.target}`);
        break;
      case "set_headline":
        if (opts.allowHeadline === false) issues.push("changing the headline isn't allowed");
        else if (ix.headline?.id !== c.target) issues.push(`unknown headline ${c.target}`);
        break;
    }
    if (c.op === "add_bullet" && c.after && ix.bullets.get(c.after)?.listId !== c.target) issues.push(`bullet ${c.after} isn't in entry ${c.target}`);
    if (c.op === "reorder_bullets" && ix.lists.has(c.target)) {
      const ids = ix.lists.get(c.target)!.bulletIds;
      const same = c.order.length === ids.length && ids.every((b) => c.order.includes(b));
      if (!same) issues.push("the new order must list every bullet of the entry exactly once");
    }
    if (c.op === "remove_bullet" && ix.bullets.has(c.target)) {
      const list = ix.bullets.get(c.target)!.listId;
      const n = (removedPerList.get(list) ?? 0) + 1;
      if (n >= (ix.lists.get(list)?.bulletIds.length ?? 0)) issues.push("would remove every bullet of the entry");
    }

    // -- the new text
    if ("text" in c) {
      issues.push(...markupProblems(c.text));
      const sources = [beforeText(ix, c), entryHeading(ix, c), ...e.evidence.map((r) => evidenceText(ix, r)).filter((x): x is string => x !== null)];
      const lacking = e.evidence.filter((r) => r.kind === "fact" && ix.lacking.has(r.id));
      if (lacking.length) issues.push("cites a topic the candidate said they haven't done");
      const unknownRefs = e.evidence.filter((r) => evidenceText(ix, r) === null && !(r.kind === "fact" && ix.lacking.has(r.id)));
      if (unknownRefs.length) issues.push(`cites evidence that doesn't exist: ${unknownRefs.map((r) => r.id).join(", ")}`);
      if (c.op === "add_bullet" && !e.evidence.length) issues.push("a new bullet must cite a fact or bullet");

      const nums = unsupportedNumbers(c.text, sources);
      if (nums.length) issues.push(`numbers not in the evidence: ${nums.join(", ")}`);

      // Technologies: in a bullet/paragraph they must come from the cited evidence; in a skills line or
      // headline, from anywhere in the resume or facts (skills you have, possibly worded the job's way).
      const pool = c.op === "rewrite_skills" || c.op === "set_headline" ? ix.allText : sources.join("\n");
      const introduced = techTerms(c.text, jobTerms, { hardOnly: true }).filter(
        (t) => !isSoftTerm(t) && !mentions(pool, t, aliasesOf(profile, t)) && !impliedBy(t).some((x) => mentions(pool, x)),
      );
      if (introduced.length) {
        if (c.op === "rewrite_skills" && opts.allowNewSkills === false) issues.push(`adds skills: ${introduced.join(", ")}`);
        else if (c.op === "rewrite_skills") issues.push(`adds skills with no evidence in the resume or facts: ${introduced.join(", ")}`);
        else issues.push(`mentions ${introduced.join(", ")}, which the cited evidence doesn't`);
      }

      // Long only relative to the resume's own style: a rewrite may be as long as the original.
      const len = plain(c.text).length;
      const allowed = Math.max(MAX_BULLET_CHARS, plain(beforeText(ix, c)).length + 25);
      if ((c.op === "rewrite_bullet" || c.op === "add_bullet") && len > allowed) soft.push(`longer than before (${len} characters): may add a line`);
      if (c.op === "set_headline" && len > MAX_HEADLINE_CHARS) issues.push("headline too long");
      if (c.op === "set_headline" && /\*|\[/.test(c.text)) issues.push("headline must be plain text");
      if (c.op === "set_headline") {
        const clash = specialtyClash(c.text, profile.roleFamily);
        if (clash) issues.push(`headline says ${clash.headline} but the role is ${clash.role}: name the role's own specialty, or none`);
        const level = headlineLevelClaim(c.text, [ix.headline?.text ?? "", ...ix.headings]);
        if (level) issues.push(`headline claims "${level}", which no role on the resume shows`);
      }
    }

    if (issues.length) {
      failed.push({ edit: { ...e, status: "dropped", issues }, issues });
      continue;
    }
    touched.add(key);
    if (c.op === "remove_bullet") {
      const list = ix.bullets.get(c.target)!.listId;
      removedPerList.set(list, (removedPerList.get(list) ?? 0) + 1);
    }
    passed.push({ ...e, status: soft.length ? "flagged" : "ok", issues: soft.length ? soft : undefined });
  }
  return { passed, failed };
}

function aliasesOf(profile: JobProfile, term: string): string[] {
  const k = profile.keywords.find((x) => canonical(x.term) === canonical(term));
  return k ? k.aliases : [];
}

// ---- Headline level -----------------------------------------------------------------------------------------

const LEVELS = /\b(senior|sr\.?|staff|lead|principal|head|chief|manager|director|architect|vp|vice president|founding)\b/gi;

/**
 * A headline is positioning (what you are, worded the job's way), not a past job title: "Backend
 * Engineer" for a Software Engineer who does backend work is fair. A level is different: "Senior",
 * "Staff", "Lead"… must appear in a role the resume shows (or the current headline). Returns the first
 * level word that doesn't.
 */
export function headlineLevelClaim(headline: string, experience: string[]): string | null {
  const shown = experience.join("\n").toLowerCase();
  for (const m of headline.matchAll(LEVELS)) {
    const word = m[1].toLowerCase().replace(/\.$/, "");
    const forms = word === "sr" || word === "senior" ? ["senior", "sr."] : [word];
    if (!forms.some((f) => new RegExp(`\\b${f.replace(".", "\\.")}`).test(shown))) return m[1];
  }
  return null;
}

// ---- Headline specialty ------------------------------------------------------------------------------------

/** Specialties a headline or a role family can name, with the words that signal each. */
const SPECIALTIES: Record<string, RegExp> = {
  "full-stack": /\bfull[\s-]?stack\b/i,
  backend: /\bback[\s-]?end\b/i,
  frontend: /\bfront[\s-]?end\b/i,
  mobile: /\b(mobile|ios|android)\b/i,
  data: /\bdata (engineer|engineering|platform)\b/i,
  ml: /\b(machine learning|ml|ai) (engineer|engineering)\b/i,
  infrastructure: /\b(infrastructure|platform|devops|site reliability|sre|cloud)\b/i,
  security: /\bsecurity\b/i,
};

function specialtyOf(text: string): string[] {
  return Object.entries(SPECIALTIES)
    .filter(([, re]) => re.test(text))
    .map(([k]) => k);
}

/**
 * A headline that names a different specialty than the job's ("Backend" for a full-stack role) works
 * against the application. Naming none is fine; naming the job's own is fine.
 */
export function specialtyClash(headline: string, roleFamily: string): { headline: string; role: string } | null {
  const role = specialtyOf(roleFamily.replace(/-/g, " ").replace(/\b(fullstack|full stack)\b/i, "full-stack"))[0] ?? specialtyFamily(roleFamily);
  if (!role) return null;
  const named = specialtyOf(headline);
  if (!named.length || named.includes(role)) return null;
  return { headline: named.join(" and "), role };
}

function specialtyFamily(family: string): string | null {
  const f = family.toLowerCase().replace(/[\s_]/g, "-");
  if (/full-?stack/.test(f)) return "full-stack";
  if (/back-?end/.test(f)) return "backend";
  if (/front-?end/.test(f)) return "frontend";
  if (/infra|platform|devops|sre|reliability|cloud/.test(f)) return "infrastructure";
  if (/^ml$|machine|ai/.test(f)) return "ml";
  if (/data/.test(f)) return "data";
  if (/mobile|ios|android/.test(f)) return "mobile";
  if (/security/.test(f)) return "security";
  return null;
}
