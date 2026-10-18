// The engine's data model. Format-neutral: a format adapter (LaTeX, JSON Resume…) turns a source
// document into a ResumeDoc and applies EditOps back to the source. Text in a ResumeDoc and in edits
// uses light markup only: **bold**, *italic*, [text](url). The adapter converts it to the format's own
// syntax (and escapes everything else), so the model never writes LaTeX.

// ---- The resume, as the engine sees it ------------------------------------------------------------------

export type SectionKind = "header" | "summary" | "experience" | "projects" | "education" | "skills" | "other";

export interface Bullet {
  id: string; // stable within a parse: "b12"
  text: string;
}

export interface BulletList {
  id: string; // "l3"
  /** What the list belongs to, as plain text: "Senior Engineer | Foo Payments | SF | 2022 – Present". */
  heading: string;
  bullets: Bullet[];
}

export interface SkillsLine {
  id: string; // "s2"
  /** "Languages" in "Languages: Go, Python". Empty when the line has no label. */
  label: string;
  text: string; // the items, e.g. "Go, Python, **TypeScript**"
}

export interface Section {
  id: string;
  kind: SectionKind;
  title: string;
  lists: BulletList[];
  skills: SkillsLine[];
  /** Prose the engine may rewrite (the summary paragraph), if the section has one. */
  paragraph?: { id: string; text: string };
  /** Read-only text of the section (entries' headings, dates…), for context. */
  context: string;
}

export interface ResumeDoc {
  /** The name and contact line etc., read-only. */
  header: string;
  /** The role line under the name ("Software Engineer"), if the adapter found one. Editable. */
  headline?: { id: string; text: string };
  sections: Section[];
  /** Everything as plain text, in reading order (for keyword coverage). */
  plainText: string;
}

// ---- Facts: true things about the candidate that the resume may not show --------------------------------

export interface Fact {
  id: string; // "f-…"
  text: string;
  /** Technologies and skills the fact proves, canonical names. */
  skills: string[];
  source: "answer" | "manual" | "import";
  createdAt: string;
}

// ---- The job ------------------------------------------------------------------------------------------

export type Seniority = "intern" | "junior" | "mid" | "senior" | "staff" | "principal" | "manager";

export interface JobInput {
  /** Empty when the posting doesn't name it. */
  company: string;
  /** The exact title from the posting, used verbatim. Empty when the posting states none. */
  role: string;
  seniority?: Seniority;
  description: string;
  location?: string;
  link?: string;
  /** What you want emphasized or played down, in your words. */
  notes?: string;
}

export interface TailorOptions {
  /** Page budget. Default: the current page count. */
  maxPages?: number;
  /** May the headline under your name change to the target role? Default true. */
  allowHeadline?: boolean;
  /** May skills you confirmed in answers be added? Default true. */
  allowNewSkills?: boolean;
  /** Ask about missing must-haves before writing. Default true. */
  askQuestions?: boolean;
}

// ---- Analysis ------------------------------------------------------------------------------------------

export interface Keyword {
  term: string; // canonical: "Kubernetes"
  aliases: string[]; // ["k8s", "K8s"]
  importance: "must" | "nice";
  /**
   * term: a concrete name recruiters type into a search (Kafka, PostgreSQL, Kubernetes, payments).
   * concept: an ability shown through work, not a word to include (distributed systems, data modeling).
   * Keyword coverage counts terms; requirement matching covers concepts.
   */
  kind: "term" | "concept";
}

export interface Requirement {
  id: string; // "r1"
  text: string;
  kind: "must" | "nice";
  category: "language" | "framework" | "infrastructure" | "data" | "practice" | "domain" | "experience" | "education" | "soft";
  keywords: string[]; // canonical terms from JobProfile.keywords
}

export interface JobProfile {
  roleFamily: string; // "backend", "full-stack", "infrastructure", "ml", "mobile", "frontend", "data"
  seniority: Seniority;
  /** One paragraph: what this team builds and what the hire will own. */
  summary: string;
  requirements: Requirement[];
  keywords: Keyword[];
  responsibilities: string[];
  /** Hard filters the resume can't fix (visa, location, clearance…): shown, never "solved". */
  dealBreakers: { text: string; kind: "visa" | "location" | "clearance" | "years" | "degree" | "other" }[];
}

export type EvidenceRef = { kind: "bullet" | "fact" | "skills" | "paragraph" | "headline"; id: string };

export interface RequirementMatch {
  requirementId: string;
  status: "strong" | "weak" | "missing";
  evidence: EvidenceRef[];
  note: string;
}

// ---- Fit -----------------------------------------------------------------------------------------------

export type FitLevel = "strong" | "stretch" | "long-shot";

export interface FitAssessment {
  level: FitLevel;
  /** Must-have requirements: clearly shown, partly shown, not shown. */
  must: { strong: number; weak: number; missing: number; total: number };
  /** Must-haves the resume doesn't show at all, as written in the posting. */
  gaps: string[];
  /** A missing must-have about years of experience or a degree: hard to argue past. */
  hardGap: boolean;
}

export interface Question {
  id: string; // "q1"
  requirementId: string;
  /** "This role needs Terraform. Have you used it? Where, and for what?" */
  question: string;
  /** Short, for chips: "Terraform". */
  topic: string;
}

export interface Answer {
  questionId: string;
  /** What you did. Empty/undefined with `none: true` means "I don't have this". */
  text?: string;
  none?: boolean;
}

// ---- Edits ---------------------------------------------------------------------------------------------

export type EditOp =
  | { op: "rewrite_bullet"; target: string; text: string }
  | { op: "remove_bullet"; target: string }
  | { op: "add_bullet"; target: string /* list id */; after: string | null /* bullet id or null = first */; text: string }
  | { op: "reorder_bullets"; target: string /* list id */; order: string[] /* bullet ids */ }
  | { op: "rewrite_paragraph"; target: string; text: string }
  | { op: "set_headline"; target: string; text: string }
  | { op: "rewrite_skills"; target: string; text: string };

export interface Edit {
  id: string; // "e1"
  change: EditOp;
  reason: string;
  requirements: string[]; // requirement ids this edit serves
  evidence: EvidenceRef[]; // where every claim in the new text comes from
  /** Set by verification. */
  status?: "ok" | "flagged" | "dropped";
  issues?: string[];
  /** Why a dropped edit was left out. */
  dropReason?: DropReason;
  /** The first version of an edit the repair round fixed, and what was wrong with it. */
  revisedFrom?: { text: string; issues: string[] };
}

/**
 * checks: failed the deterministic checks (a number, technology or level the evidence doesn't have, an
 * unknown target); fact-check: the fact-checking model found a claim the evidence doesn't support;
 * apply: couldn't be applied to the document; build: broke the build; page-fit: cut to fit the page budget.
 */
export type DropReason = "checks" | "fact-check" | "apply" | "build" | "page-fit";

// ---- Verification & report ------------------------------------------------------------------------------

export interface BuildCheck {
  ok: boolean;
  pages: number | null;
  /** Lines on the last page beyond the budget, if the build overflowed. */
  overflowLines?: number;
  /** Plain text extracted from the built output (PDF), for keyword coverage. */
  text?: string;
  atsScore?: number | null;
  errors: { message: string; line?: number; file?: string }[];
}

export interface Coverage {
  requirementsStrong: number;
  requirementsWeak: number;
  requirementsMissing: number;
  requirementsTotal: number;
  /** Must-have keywords present in the text (or their aliases). */
  keywordsFound: string[];
  keywordsMissing: string[];
}

export interface Report {
  before: Coverage & { build?: BuildCheck };
  after: Coverage & { build?: BuildCheck };
  strategy: string;
  warnings: string[];
}

// ---- Sessions ------------------------------------------------------------------------------------------

export type SessionStatus = "created" | "analyzing" | "needs_input" | "writing" | "verifying" | "ready" | "failed" | "cancelled";

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  byStep: Record<string, { calls: number; inputTokens: number; outputTokens: number; ms: number }>;
}

export interface TailorEvent {
  at: string;
  type: "status" | "step" | "warning" | "error";
  status?: SessionStatus;
  step?: string;
  message: string;
}

export interface Session {
  id: string;
  version: number; // engine schema version
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  job: JobInput;
  options: TailorOptions;
  /** The source document, as given (format-specific, opaque to the engine). */
  source: SourceFiles;
  doc?: ResumeDoc;
  profile?: JobProfile;
  matches?: RequirementMatch[];
  /** How well the resume fits the job before rewriting, from the matching (see assessFit). */
  fit?: FitAssessment;
  questions?: Question[];
  answers?: Answer[];
  facts: Fact[];
  /** Facts learned from your answers in this session (to save to your fact bank). */
  newFacts: Fact[];
  edits?: Edit[];
  /** Edits the model wrote that couldn't be read as edits at all (before any check), with why. */
  skippedSuggestions?: string[];
  /** The edits chosen in review (saved with every preview), so the choice survives a reload. */
  selection?: string[];
  strategy?: string;
  report?: Report;
  /** The tailored document with every ok edit applied (review may accept a subset). */
  draft?: SourceFiles;
  events: TailorEvent[];
  usage: UsageTotals;
  provenance: { engine: string; prompts: string; provider: string; model: string };
  /** The client's own references (e.g. which resume this is for); the engine doesn't read them. */
  context: Record<string, string>;
  error?: { message: string; kind?: string; retryable?: boolean };
}

/** A document as files: path → content. The main file is `main`. */
export interface SourceFiles {
  main: string;
  files: Record<string, string>;
}
