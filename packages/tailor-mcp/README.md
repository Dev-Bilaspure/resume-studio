# resume-tailor-mcp

The resume tailoring engine as an MCP server, so an assistant (Claude Desktop, Claude Code, any MCP
client) can tailor a LaTeX resume on your computer to a job posting, ask you about gaps, and save the
result next to the original.

## Tools

| Tool | |
|---|---|
| `tailor_resume` | `resume_path` (main .tex or its folder), `job_description`, `company`, `role`, optional `seniority`, `max_pages`, `ask_questions`. Returns the changes with reasons, or questions about must-haves the resume doesn't show. |
| `answer_tailoring_questions` | Your answers in your own words (`none: true` for what you haven't done). Remembered for next time. |
| `get_tailoring_session` | Check on a run (or resume one cut off by a restart). |
| `save_tailored_resume` | Writes the tailored resume to a new folder, with `jd.md`. `reject_edit_ids` leaves changes out. The original is never changed. |

Runs take 1–4 minutes; each call waits up to `wait_seconds` (default 240) and sends progress
notifications, then says how to keep waiting.

## Set up (Claude Desktop)

Needs Node 24+, TeX Live (`latexmk`) and poppler (`pdfinfo`, `pdftotext`). In
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "resume-tailor": {
      "command": "node",
      "args": ["/path/to/resume-studio/packages/tailor-mcp/bin/resume-tailor-mcp.js"]
    }
  }
}
```

With no other settings it uses your Claude Code login. To use an API instead, add `"env"` with
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` + `TAILOR_PROVIDER=openai` + `TAILOR_MODEL`, or
`GOOGLE_VERTEX_PROJECT` + `GOOGLE_VERTEX_LOCATION` + `TAILOR_PROVIDER=vertex` + `TAILOR_MODEL`.
Sessions and your saved facts live in `~/.resume-tailor` (`TAILOR_MCP_DATA` to move them).
