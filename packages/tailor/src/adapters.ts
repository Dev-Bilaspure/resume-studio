// What the engine needs from its surroundings. Everything is an interface so the engine can run in
// a desktop app, a server or a CLI with different storage, formats and build tools.
import type { BuildCheck, EditOp, Fact, ResumeDoc, Session, SourceFiles } from "./types.ts";

/** Turns a source document into a ResumeDoc and applies edits back to it, keeping everything else intact. */
export interface FormatAdapter {
  readonly format: string; // "latex", "jsonresume"
  parse(source: SourceFiles): Promise<ResumeDoc> | ResumeDoc;
  /** Applies edits in order. Throws EditApplyError for an edit it can't apply (unknown target…). */
  apply(source: SourceFiles, doc: ResumeDoc, edits: { id: string; change: EditOp }[]): Promise<SourceFiles> | SourceFiles;
}

export class EditApplyError extends Error {
  editId: string;
  constructor(editId: string, message: string) {
    super(message);
    this.name = "EditApplyError";
    this.editId = editId;
  }
}

/**
 * Optional: builds a document and reports what came out (pages, errors, extracted text, ATS score).
 * With one, the engine checks page fit and real-PDF keyword coverage and repairs overflow; without one,
 * it relies on the document text.
 */
export interface BuildVerifier {
  build(source: SourceFiles, opts: { maxPages?: number; signal?: AbortSignal }): Promise<BuildCheck>;
  /** Maps a build error (file:line) back to the edit that touched it, when possible. */
  editAt?(source: SourceFiles, error: { file?: string; line?: number }): string | null;
}

export interface SessionStore {
  get(id: string): Promise<Session | null>;
  put(session: Session): Promise<void>;
}

export interface FactStore {
  list(): Promise<Fact[]>;
  add(facts: Fact[]): Promise<void>;
}

export function memorySessionStore(): SessionStore {
  const m = new Map<string, Session>();
  return {
    async get(id) {
      const s = m.get(id);
      return s ? structuredClone(s) : null;
    },
    async put(s) {
      m.set(s.id, structuredClone(s));
    },
  };
}

export function memoryFactStore(initial: Fact[] = []): FactStore {
  const facts = [...initial];
  return {
    async list() {
      return [...facts];
    },
    async add(more) {
      for (const f of more) if (!facts.some((x) => x.id === f.id)) facts.push(f);
    },
  };
}
