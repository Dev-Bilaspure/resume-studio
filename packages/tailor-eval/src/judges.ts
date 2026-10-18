// Independent judges. They see only what a reader would: the PDF text of each resume and the job
// posting. They never see the engine's analysis, its edits or its reasons, so they can't simply agree with it.
import type { LLM } from "@resume-studio/llm";
import { z } from "zod";

// ---- Truthfulness audit ------------------------------------------------------------------------------------

export const AuditSchema = z.object({
  issues: z.array(
    z.object({
      kind: z.enum(["invented_skill", "inflated_scope", "changed_fact", "unsupported_claim"]),
      severity: z.enum(["high", "medium", "low"]),
      quote: z.string().describe("The exact words from the TAILORED resume"),
      why: z.string().describe("What the original says instead, or that it says nothing about this"),
    }),
  ),
});
export type Audit = z.infer<typeof AuditSchema>;

const AUDIT_SYSTEM = `You audit a tailored resume for honesty. You get the ORIGINAL resume (the only source of truth about the candidate) and a TAILORED version of it written for a job.

List every statement in the TAILORED version that the ORIGINAL does not support:
- invented_skill: a technology, tool, language, method or domain the original never mentions or clearly implies.
- inflated_scope: more scale, seniority, leadership, ownership, impact or responsibility than the original states (e.g. "led" for "worked on", "architected" for "built", a team or user count that grew).
- changed_fact: a number, date, title, employer, degree, school or location that differs from the original.
- unsupported_claim: any other new claim about the candidate that the original doesn't back.

These are fine and must NOT be listed: rewording; reordering; shortening or removing content; using a common synonym or the job's spelling for something the original says (e.g. "K8s" for "Kubernetes"); making explicit what a bullet plainly implies (a REST API built in Express is "Node.js" work); a headline that names a role family the experience clearly shows.

Severity: high = a recruiter or interviewer would call it false; medium = a stretch the candidate would have to walk back; low = slightly loose wording.
Quote the tailored text exactly. If nothing is unsupported, return an empty list. Be strict but not pedantic.`;

export async function auditTruthfulness(llm: LLM, original: string, tailored: string, signal?: AbortSignal, confirmed: string[] = []): Promise<Audit> {
  // What the candidate confirmed in answers is a source too, exactly as worded, and no more.
  const answers = confirmed.length
    ? `\n\nThe candidate also CONFIRMED these (as true as the original; nothing beyond their wording):\n${confirmed.map((c) => `- ${c}`).join("\n")}`
    : "";
  const res = await llm.generate({
    system: AUDIT_SYSTEM,
    prompt: `ORIGINAL resume:\n"""\n${original.trim()}\n"""${answers}\n\nTAILORED resume:\n"""\n${tailored.trim()}\n"""`,
    schema: AuditSchema,
    schemaName: "truthfulness_audit",
    temperature: 0,
    signal,
    step: "eval-audit",
  });
  return res.data;
}

// ---- Recruiter screen, one resume at a time ----------------------------------------------------------------

export const ScreenSchema = z.object({
  advance: z.boolean().describe("Would you advance this candidate to a phone screen for this role?"),
  fit: z.number().min(1).max(10).describe("How well the resume fits this role, 1–10"),
  shown: z.array(z.string()).describe("The posting's must-haves this resume clearly shows"),
  missing: z.array(z.string()).describe("The posting's must-haves it doesn't show"),
  reason: z.string().describe("One or two sentences: what decided it"),
});
export type Screen = z.infer<typeof ScreenSchema>;

const SCREEN_SYSTEM = `You are an experienced technical recruiter screening software engineering candidates for the role below. You see one resume. Hiring managers expect you to advance candidates whose resumes clearly show the role's must-have experience at the right level, with concrete impact, and to pass on the rest: phone screens are expensive, and most applicants for a role like this are not advanced.

Read the resume as you would in a real screen: quickly, looking for evidence of each requirement in the posting's terms. Judge only what is written; don't reward length or formatting, and don't assume experience the resume doesn't state.`;

export async function screenOne(llm: LLM, posting: { company: string; role: string; description: string }, resume: string, signal?: AbortSignal): Promise<Screen> {
  const res = await llm.generate({
    system: SCREEN_SYSTEM,
    prompt: `ROLE: ${posting.role} at ${posting.company}\n\nJOB POSTING:\n"""\n${posting.description.trim()}\n"""\n\nRESUME:\n"""\n${resume.trim()}\n"""`,
    schema: ScreenSchema,
    schemaName: "recruiter_screen",
    temperature: 0,
    signal,
    step: "eval-screen",
  });
  return res.data;
}

// ---- Simulated candidate ------------------------------------------------------------------------------------

export const CandidateSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string(),
      answer: z.string().nullable().describe("In the candidate's voice, one or two sentences, only what the history states; null if it doesn't cover this"),
    }),
  ),
});

const CANDIDATE_SYSTEM = `You play a job candidate answering questions about your experience. Your complete, true history is below; it is everything you have done. Answer each question in the first person, in one or two plain sentences, using only what the history states. Add nothing: no numbers, tools, scope or outcomes it doesn't give. If the history doesn't cover a question, or says you haven't done it, answer null. Being honest matters more than getting the job.`;

/** Answers the engine's questions as the candidate would, from their history alone. */
export async function answerAsCandidate(llm: LLM, history: string, questions: { id: string; question: string; topic: string }[], signal?: AbortSignal) {
  const res = await llm.generate({
    system: CANDIDATE_SYSTEM,
    prompt: `YOUR HISTORY:\n"""\n${history.trim()}\n"""\n\nQUESTIONS:\n${questions.map((q) => `[${q.id}] (${q.topic}) ${q.question}`).join("\n")}`,
    schema: CandidateSchema,
    schemaName: "candidate_answers",
    temperature: 0,
    signal,
    step: "eval-candidate",
  });
  return res.data.answers;
}
