// The MCP server: the tools, with descriptions an assistant can act on, and progress notifications
// while a run works.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createTools, type ToolsDeps } from "./tools.ts";

type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void> };

/** Sends a progress notification per step, when the client asked for them. */
function progress(extra: Extra) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let n = 0;
  return (message: string) => void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } }).catch(() => {});
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: (e as Error).message }], isError: true });

export function createMcpServer(deps: ToolsDeps) {
  const tools = createTools(deps);
  const server = new McpServer({ name: "resume-tailor", version: "0.1.0" });
  const wait = z.number().int().min(0).max(600).optional().describe("How long to wait for the run, in seconds (default 240). It keeps running after; check again with get_tailoring_session.");

  server.registerTool(
    "tailor_resume",
    {
      title: "Tailor a resume to a job",
      description:
        "Tailors a LaTeX resume on this computer to a job posting: reads the posting, matches each requirement to the resume, rewrites the relevant parts in the job's language, and fact-checks every change against the resume (nothing is invented; numbers can't appear from nowhere). The result is compiled to check it builds and fits the page. It may come back with questions about must-haves the resume doesn't show: ask the candidate, then call answer_tailoring_questions. Takes 1–4 minutes.",
      inputSchema: {
        resume_path: z.string().describe("Absolute path to the resume's main .tex file or its folder"),
        job_description: z.string().min(80).describe("The full job posting text"),
        company: z.string().min(1),
        role: z.string().min(1).describe("The exact job title from the posting"),
        seniority: z.enum(["intern", "junior", "mid", "senior", "staff", "principal", "manager"]).optional(),
        max_pages: z.number().int().min(1).max(4).optional().describe("Page budget; default: the resume's current length"),
        ask_questions: z.boolean().optional().describe("Ask about missing must-haves first (default true)"),
        wait_seconds: wait,
      },
    },
    async (a, extra) => {
      try {
        return text(
          await tools.tailor({
            resumePath: a.resume_path,
            jobDescription: a.job_description,
            company: a.company,
            role: a.role,
            seniority: a.seniority,
            maxPages: a.max_pages,
            askQuestions: a.ask_questions,
            waitSeconds: a.wait_seconds,
            onProgress: progress(extra as unknown as Extra),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "answer_tailoring_questions",
    {
      title: "Answer the tailoring questions",
      description:
        "Gives the candidate's answers to the questions tailor_resume asked, then continues tailoring. Use the candidate's own words; set none: true for anything they haven't done. Answers are remembered for future applications.",
      inputSchema: {
        session_id: z.string(),
        answers: z.array(z.object({ question_id: z.string(), answer: z.string().optional(), none: z.boolean().optional() })),
        wait_seconds: wait,
      },
    },
    async (a, extra) => {
      try {
        return text(
          await tools.answer({
            sessionId: a.session_id,
            answers: a.answers.map((x) => ({ questionId: x.question_id, answer: x.answer, none: x.none })),
            waitSeconds: a.wait_seconds,
            onProgress: progress(extra as unknown as Extra),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_tailoring_session",
    {
      title: "Check a tailoring session",
      description: "The state of a tailoring session: still working, waiting for answers, or ready with every change and its reason. Resumes a run that was interrupted.",
      inputSchema: { session_id: z.string(), wait_seconds: wait },
    },
    async (a, extra) => {
      try {
        return text(await tools.get({ sessionId: a.session_id, waitSeconds: a.wait_seconds, onProgress: progress(extra as unknown as Extra) }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "save_tailored_resume",
    {
      title: "Save the tailored resume",
      description: "Writes the tailored resume to a new folder (the original is never changed), with the job description as jd.md. Leave out changes the candidate doesn't want with reject_edit_ids.",
      inputSchema: {
        session_id: z.string(),
        output_dir: z.string().describe("A new or empty folder"),
        reject_edit_ids: z.array(z.string()).optional(),
      },
    },
    async (a) => {
      try {
        return text(await tools.save({ sessionId: a.session_id, outputDir: a.output_dir, rejectEditIds: a.reject_edit_ids }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
