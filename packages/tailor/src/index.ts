// @resume-studio/tailor: tailors a software engineer's resume to a job, truthfully. A workflow, not an
// open-ended agent: analyze the job → match evidence → (ask about gaps) → write edits with citations →
// verify (deterministic checks + fact-check) → repair → build and fit the page budget → report.
export * from "./adapters.ts";
export { addedBulletId, applyToDoc, docText, mergeFitEdits } from "./doc.ts";
export { ENGINE_VERSION, SessionError, createTailorEngine, type EngineDeps, type StartInput, type TailorEngine } from "./engine.ts";
export { LEXICON, canonical, impliedBy, mentions, techTerms, variants } from "./lexicon.ts";
export { PROMPTS_VERSION, renderDoc } from "./prompts.ts";
export { readPosting, type PostingDetails } from "./posting.ts";
export { jobCompany, jobTitle } from "./job.ts";
export { coverage, markupProblems, numbers, plain, unsupportedNumbers } from "./text.ts";
export * from "./types.ts";
export { entryHeading } from "./verify.ts";
export { checkEdits, indexDoc } from "./verify.ts";
// Node-only storage (fs): import "@resume-studio/tailor/node".
