# tailor-eval

Measures whether tailoring helps a resume get through a recruiter screen, and whether it stays honest.

For each case (a resume and a job posting) it runs the real engine (no gap questions, no saved facts),
then an independent judge that sees only what a reader would, the PDF text and the posting:

- **Recruiter screen.** The original and the tailored resume are each screened on their own, in a fresh
  context: advance to a phone screen or not, fit (1–10), which must-haves are shown. The report compares
  how often each version is advanced and lists every decision that changed.
- **Truthfulness audit.** The tailored text against the original: anything invented, inflated, changed or
  credited to the wrong work, by severity.

## Data

```
eval-data/
  resumes/<id>/main.tex        a LaTeX resume (plus anything it needs)
  jds/<id>.md                  a job posting: front matter + the posting's text
  cases.json                   [{ "resume": "<id>", "jd": "<id>" }, …]   (default: every pair)
```

```markdown
---
company: Databricks
role: Software Engineer (Backend - SDE 2)
level: mid            # intern | junior | mid | senior | staff
family: backend
location: Bengaluru, India
url: https://…
---

The posting's text: the role, responsibilities, requirements, nice-to-haves.
```

`eval-data/` and `eval-results/` are git-ignored: postings are other companies' text and resumes are
personal.

## Run

```sh
pnpm eval run --out eval-results/<name> --model opus --judge-model opus [--only <case,…>] [--limit N]
pnpm eval report eval-results/<name>
```

Each case is saved as it finishes. Running the same command again continues where it stopped (after a
usage limit, say). A case costs about 5 engine calls and 3 judge calls.

## Reading the results

The judge is a model, not a recruiter: treat small differences as noise, and look at the decisions that
changed and the reasons given. Use a different provider for `--judge-provider` when you can, so the
judge doesn't share the engine's blind spots. Truthful tailoring can't supply experience the candidate
doesn't have; it can make what they have visible in the posting's terms. Expect gains where the fit is
real but hidden, and none where it isn't.
