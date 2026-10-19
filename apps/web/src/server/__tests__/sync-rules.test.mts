import assert from "node:assert/strict";
import { test } from "node:test";
import { findSecret, isSynced } from "../sync-rules.ts";

test("only data is synced: resumes, facts, sessions, AI choices", () => {
  for (const p of ["resumes/first-resume/main.tex", "resumes/first-resume/photo.png", "resumes/_profile/facts.json", "resumes/acme/jd.md", ".resume-studio/tailor/sessions/ts-mvefagb7-7fdh.json", ".resume-studio/ai.json"])
    assert.equal(isSynced(p), true, p);
});

test("nothing else: the app, builds, keys, history, junk, tricks", () => {
  for (const p of [
    "apps/web/src/server/sync.ts",
    "package.json",
    ".env",
    "resumes",
    ".resume-studio/secrets.json",
    "resumes/x/secrets.json",
    ".resume-studio/build/first-resume/main.aux",
    ".resume-studio/publish/first-resume/1.pdf",
    ".resume-studio/git/HEAD",
    ".resume-studio/sync/config.json",
    ".resume-studio/tailor/work/ts-1/draft.pdf",
    ".resume-studio/tailor/sessions/../../../package.json",
    ".resume-studio/tailor/sessions/x.json.123.abcd.tmp",
    "resumes/_profile/facts.json.lock/x",
    "resumes/x/.git/config",
    "resumes/x/.DS_Store",
    "resumes/x/main.tex~",
    "resumes/../apps/web/x.ts",
    "resumes//x",
  ])
    assert.equal(isSynced(p), false, p);
});

test("secrets are recognized; ordinary resume text isn't", () => {
  assert.equal(findSecret("key: sk-ant-api03-" + "A".repeat(40)), "an Anthropic API key");
  assert.equal(findSecret("OPENAI=sk-proj-" + "b".repeat(48)), "an OpenAI API key");
  assert.equal(findSecret("AIza" + "C".repeat(35)), "a Google API key");
  assert.equal(findSecret("-----BEGIN RSA PRIVATE KEY-----"), "a private key");
  assert.equal(findSecret("token ghp_" + "d".repeat(36)), "a GitHub token");
  for (const ok of ["Built a risk-scoring service in Go", "\\section{Skills} sk-learn, scikit", "Reduced p95 latency 40%", "task-ask-sk-ant"]) assert.equal(findSecret(ok), null, ok);
});
