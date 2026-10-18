// Types shared by the server (compiler, workspace, snapshots) and the browser.

export type Engine = "pdflatex" | "xelatex" | "lualatex" | "latex";
export const ENGINES: { id: Engine; label: string; hint: string }[] = [
  { id: "pdflatex", label: "pdfLaTeX", hint: "Fastest. Best text extraction with glyphtounicode." },
  { id: "xelatex", label: "XeLaTeX", hint: "System fonts via fontspec." },
  { id: "lualatex", label: "LuaLaTeX", hint: "System fonts via fontspec, Lua scripting." },
  { id: "latex", label: "LaTeX (DVI)", hint: "latex → DVI → PDF, for PSTricks and other DVI-only packages." },
];

export interface ResumeMeta {
  id: string; // folder name under resumes/
  name: string;
  engine: Engine;
  mainFile: string; // relative to the resume folder
  template?: string;
  /**
   * Trusted: TeX may run commands (-shell-escape, for minted/svg) and the project's latexmkrc is
   * honoured. Both run code on this Mac, so it's off unless you turn it on for a project you trust.
   */
  trusted: boolean;
  /** Stop at the first error instead of carrying on to produce (partial) output. */
  haltOnError: boolean;
  /** Set on a resume tailored for a job: what it's for, and where it came from. */
  application?: Application;
  createdAt: string;
  updatedAt: string;
}

export type ApplicationStatus = "draft" | "applied" | "interviewing" | "offer" | "rejected" | "withdrawn";

export interface Application {
  company: string;
  role: string;
  link?: string;
  /** The resume this one was tailored from. */
  baseResume: string;
  /** The tailoring session (its full record is in tailor.json next to the resume). */
  session: string;
  createdAt: string;
  status: ApplicationStatus;
}

export interface FileEntry {
  path: string; // posix, relative to the resume folder
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  /** Text files open in the editor; others (images, fonts, PDFs) are listed only. */
  editable: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  hash: string; // sha256 of the content on disk; sent back on save to detect concurrent edits
  mtimeMs: number;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  kind: "latex" | "package" | "box" | "reference" | "citation" | "font" | "other";
  /** Relative to the resume folder; null when the log doesn't say, or it's outside (a .sty in TeX Live). */
  file: string | null;
  line: number | null;
  /** For errors raised inside a TeX Live file (a .sty/.cls): its name, e.g. "XCharter.sty". */
  origin?: string;
  message: string;
  /** Extra context from the log: the offending source excerpt, the package's continuation lines. */
  detail?: string;
}

export type BuildStatus = "ok" | "error" | "timeout" | "failed-to-start";

export interface BuildResult {
  id: number;
  resumeId: string;
  status: BuildStatus;
  /** The PDF to show. On error this is null and the preview keeps the last good PDF. */
  pdfUrl: string | null;
  /** Set when TeX produced a PDF despite errors: viewable on request, never shown automatically. */
  partialPdfUrl: string | null;
  startedAt: number;
  durationMs: number;
  /** The engine this build ran with (may differ from the setting: the LuaLaTeX font fallback). */
  engine?: Engine;
  pages: number | null;
  diagnostics: Diagnostic[];
  /** Last lines of the latexmk output, for failures the log parser can't explain (missing engine, crash). */
  outputTail: string;
  ats: AtsReport | null;
}

export interface BuildState {
  resumeId: string;
  running: boolean;
  last: BuildResult | null;
  lastGood: BuildResult | null;
}

export type AtsStatus = "pass" | "warn" | "fail";

export type AtsCategory = "parsing" | "structure" | "formatting" | "content";

export interface AtsCheck {
  id: string;
  category: AtsCategory;
  title: string;
  status: AtsStatus;
  detail: string;
  /** How to fix it, when it isn't passing. */
  fix?: string;
  /** Points to the source, when the check can tell where. */
  file?: string;
  line?: number;
}

export interface FontInfo {
  name: string;
  type: string;
  embedded: boolean;
  unicodeMap: boolean;
}

export interface AtsReport {
  score: number; // 0–100
  checks: AtsCheck[];
  /** Plain text exactly as an ATS parser would extract it (pdftotext, reading order). */
  text: string;
  stats: {
    pages: number;
    words: number;
    fileSizeKB: number;
    fonts: FontInfo[];
    title: string | null;
    author: string | null;
  };
  /** Present when the ATS tools (poppler: pdftotext, pdffonts, pdfinfo) are missing. */
  unavailable?: string;
}

export interface SnapshotInfo {
  sha: string;
  shortSha: string;
  message: string;
  labels: string[];
  createdAt: number; // ms
  /** Made automatically (periodic auto-snapshot, before a restore or delete), not by you. */
  auto: boolean;
  /** Lines added/removed compared with the previous snapshot of this resume. */
  insertions: number;
  deletions: number;
}

export interface SystemStatus {
  /**
   * Where TeX runs: this machine's TeX Live, or the compile service (the TeX Live container from
   * docker-compose.yml). `error`: the service can't be reached.
   */
  compiler: { mode: "local" | "service"; url: string | null; error: string | null };
  tex: { available: boolean; latexmk: string | null; engines: Record<Engine, string | null>; synctex: string | null; version: string | null };
  ats: { available: boolean; missing: string[] };
  git: { available: boolean };
  root: string;
}

export type ServerEvent =
  | { type: "build-start"; resumeId: string; buildId: number }
  | { type: "build"; result: BuildResult }
  | { type: "files"; resumeId: string; changes: { path: string; hash: string | null }[] }
  | { type: "resumes" }
  | { type: "snapshots"; resumeId: string }
  | { type: "tailor"; sessionId: string; resumeId: string; status: string; message: string; step?: string };

/** Completions gathered from every file in the project (see src/server/symbols.ts). */
export interface ProjectSymbols {
  labels: { name: string; file: string; line: number }[];
  citations: { key: string; type: string; title?: string; author?: string; file: string }[];
  commands: { name: string; args: number }[];
  environments: string[];
  packages: string[];
  /** Every file in the project, for \input, \include, \includegraphics, \addbibresource. */
  files: string[];
}

export interface OutputFile {
  name: string;
  size: number;
}

export interface WordCount {
  words: number;
  headers: number;
  captions: number;
  text: number;
  raw: string;
}
