// Describing a job when the posting leaves things out. No dependencies, so browser code can import it
// (@resume-studio/tailor/job) without pulling in the engine.

/** The job's title for display: as posted, or a neutral stand-in. */
export function jobTitle(job: { role?: string }): string {
  return job.role?.trim() || "Untitled role";
}

/** The company for display: as posted, or a neutral stand-in. */
export function jobCompany(job: { company?: string }): string {
  return job.company?.trim() || "Unnamed company";
}
