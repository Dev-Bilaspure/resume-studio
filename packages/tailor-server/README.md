# tailor-server

The resume tailoring engine as an HTTP service: send a LaTeX resume and a job posting, get back
fact-checked edits, a report, and the tailored source. Drafts are compiled with TeX Live, so every
result is known to build and fit its page budget.

## Run

```sh
# Local, with your Claude Code login (loopback only, no key needed):
TAILOR_ENABLE_CLAUDE_CODE=1 node packages/tailor-server/src/main.ts

# Docker, with an API provider (from the repository root):
docker build -f packages/tailor-server/Dockerfile -t resume-tailor-server .
docker run -p 8787:8787 -e TAILOR_API_KEY=change-me -e ANTHROPIC_API_KEY=sk-ant-… -v tailor-data:/data resume-tailor-server
```

Needs Node 24+ (it runs the TypeScript sources directly), TeX Live (`latexmk`) and poppler (`pdfinfo`,
`pdftotext`). The Docker image has all three: it's built on the official, complete TeX Live 2026 (the
same distribution as Overleaf and MacTeX, pinned by digest), so a resume that builds there builds here.
It's large (about 10 GB unpacked, 2.7 GB to download) for that reason.

Fonts: a resume that asks for a font this machine doesn't have (`\setmainfont{Arial}` on Linux) is
checked with its metric-compatible free stand-in: Liberation Sans for Arial and Helvetica, Liberation
Serif for Times New Roman, Liberation Mono for Courier New, Carlito for Calibri, Caladea for Cambria.
They have the same character widths, so line breaks and page counts match. Only the check's copy
changes; the LaTeX you get back still names the original font.

## Configuration

| Variable | |
|---|---|
| `HOST`, `PORT` | Default `127.0.0.1:8787`. |
| `TAILOR_API_KEY` | Clients send `Authorization: Bearer <key>`. Required unless `HOST` is loopback. |
| `TAILOR_DATA_DIR` | Sessions and uploaded assets. Default `./tailor-data`. |
| `ANTHROPIC_API_KEY` (`ANTHROPIC_BASE_URL`) | Enables the Anthropic API. Model: `TAILOR_ANTHROPIC_MODEL` (default `claude-opus-5-5`). |
| `OPENAI_API_KEY` (`OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`) | Enables OpenAI. Model: `TAILOR_OPENAI_MODEL`. |
| `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION` (`GOOGLE_APPLICATION_CREDENTIALS`) | Enables Vertex AI. Model: `TAILOR_VERTEX_MODEL`. |
| `TAILOR_ENABLE_CLAUDE_CODE=1` (`CLAUDE_CODE_PATH`) | Uses the logged-in Claude Code CLI on this machine. Not for shared servers. |
| `TAILOR_PROVIDER`, `TAILOR_MODEL` | The default provider and its model. Default: the first configured. |
| `TAILOR_CONCURRENCY` | Runs at once (default 2); more wait in a queue. |
| `TAILOR_MAX_BODY_BYTES` | Request size limit (default 10 MB). |

Credentials only come from the environment. A request can choose among the configured providers and
name a model, nothing more.

## API

All bodies are JSON. Errors are `{ "error": { "code", "message" } }` with a matching status.

| | |
|---|---|
| `GET /health` | `{ ok, engine, prompts }` (no auth). |
| `GET /v1/providers` | Configured providers, their default and suggested models. |
| `POST /v1/sessions` | Start tailoring. Returns the session (202); it runs in the background. |
| `GET /v1/sessions/:id` | The session: `status`, `profile` (the job, as read), `matches`, `questions`, `edits`, `report`, `events`, `usage`. Plus `running`, and `interrupted` after a server restart (resume with `/retry`). |
| `GET /v1/sessions/:id/events` | Server-sent events: past events first, then each step as it happens. |
| `POST /v1/sessions/:id/answers` | `{ answers: [{ questionId, text }` or `{ questionId, none: true }] }`. `[]` skips the questions. |
| `POST /v1/sessions/:id/retry` | After `failed`, `cancelled` or `interrupted`. Finished steps are kept. |
| `POST /v1/sessions/:id/cancel` | |
| `POST /v1/sessions/:id/preview` | `{ accepted: [editId] }` → `{ source, build: { ok, pages, errors } }`. |
| `POST /v1/sessions/:id/finalize` | `{ accepted: [editId] }` → `{ source, facts }`. `facts` are what the candidate's answers taught; store them and send them with the next session. |
| `DELETE /v1/sessions/:id` | |

Start body:

```json
{
  "job": { "company": "Acme", "role": "Senior Backend Engineer", "seniority": "senior", "description": "…the full posting…" },
  "source": { "format": "latex", "main": "main.tex", "files": { "main.tex": "\\documentclass…" } },
  "assets": { "photo.jpg": "<base64>" },
  "options": { "maxPages": 1, "askQuestions": true, "allowHeadline": true },
  "facts": [{ "id": "f1", "text": "Wrote Terraform modules for the staging VPC at Foo.", "skills": ["Terraform"], "source": "answer", "createdAt": "…" }],
  "provider": "anthropic",
  "model": "claude-opus-5-5",
  "context": { "user": "your-user-id" }
}
```

Status moves `analyzing → needs_input? → writing → verifying → ready` (or `failed` / `cancelled`). With
`askQuestions`, a session pauses at `needs_input` with `questions` about must-haves the resume doesn't
show; answer them (or send `[]`) to continue. Each edit in `edits` has the change, its `reason`, the
`requirements` it serves, the `evidence` it's based on, and a `status` (`ok`, `flagged` for a human to
check, or `dropped` with the `issues` that failed it).
