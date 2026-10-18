import assert from "node:assert/strict";
import { test } from "node:test";
import { addedBulletId, applyToDoc, mergeFitEdits } from "./doc.ts";
import { mentions, techTerms } from "./lexicon.ts";
import { markupProblems, numbers, plain, unsupportedNumbers } from "./text.ts";
import type { Edit, Fact, JobProfile, ResumeDoc } from "./types.ts";
import { checkEdits, indexDoc, headlineLevelClaim } from "./verify.ts";

const doc: ResumeDoc = {
  header: "Dev Example | dev@example.com",
  headline: { id: "h1", text: "Software Engineer" },
  sections: [
    {
      id: "sec1",
      kind: "experience",
      title: "Work Experience",
      context: "",
      skills: [],
      lists: [
        {
          id: "l1",
          heading: "Northwind Labs, Pune | Software Development Engineer | Aug 2023 – Oct 2025",
          bullets: [
            { id: "b1", text: "Designed a **DAG-driven** pipeline on **Temporal**, cutting pipeline failures by **60%**; ran workers on **Kubernetes (AKS)**." },
            { id: "b2", text: "Built backend REST services in **Node.js** and **TypeScript** on **AWS Lambda**." },
            { id: "b3", text: "Developed a **React** video editor." },
          ],
        },
      ],
    },
    { id: "sec2", kind: "skills", title: "Skills", context: "", lists: [], skills: [{ id: "s1", label: "Languages", text: "TypeScript, JavaScript, Go, SQL" }] },
  ],
  plainText: "",
};

const profile: JobProfile = {
  roleFamily: "backend",
  seniority: "mid",
  summary: "",
  requirements: [{ id: "r1", text: "Kubernetes", kind: "must", category: "infrastructure", keywords: ["Kubernetes"] }],
  keywords: [
    { term: "Kubernetes", aliases: ["K8s"], importance: "must", kind: "term" },
    { term: "Terraform", aliases: [], importance: "must", kind: "term" },
  ],
  responsibilities: [],
  dealBreakers: [],
};

const facts: Fact[] = [{ id: "f1", text: "Wrote Terraform modules for the AKS clusters at Northwind Labs.", skills: ["Terraform"], source: "answer", createdAt: "" }];

const edit = (id: string, change: Edit["change"], evidence: Edit["evidence"] = []): Edit => ({ id, change, reason: "", requirements: [], evidence });

test("numbers normalize units and thousands", () => {
  assert.deepEqual(numbers("cut latency 480ms → 120 ms, 60 percent fewer, 1,350 events/sec, 3 billion rows").sort(), ["120ms", "1350", "3B", "480ms", "60%"].sort());
  assert.deepEqual(unsupportedNumbers("cut failures by 60% across 12 services", ["cutting pipeline failures by 60%"]), ["12"]);
  assert.deepEqual(unsupportedNumbers("reduced failures 60 percent", ["by **60%**"]), []);
});

test("markup is checked and stripped", () => {
  assert.equal(plain("Built **Go** services with *care* ([repo](https://x.y))"), "Built Go services with care (repo)");
  assert.deepEqual(markupProblems("Built **Go services"), ["unbalanced ** (bold)"]);
  assert.match(markupProblems("Used \\textbf{Go}").join(), /LaTeX command/);
});

test("lexicon: aliases count, short terms are case-sensitive", () => {
  assert.equal(mentions("Ran workers on K8s", "Kubernetes"), true);
  assert.equal(mentions("let's go there", "Go"), false);
  assert.equal(mentions("Services in Go and Rust", "Go"), true);
  assert.deepEqual(techTerms("Node.js and TypeScript on AWS Lambda", [], { hardOnly: true }).sort(), ["AWS", "AWS Lambda", "Node.js", "TypeScript"].sort());
});

test("a rewrite may reuse the evidence's numbers and tech, not invent them", () => {
  const ix = indexDoc(doc, facts);
  const good = edit("e1", { op: "rewrite_bullet", target: "b1", text: "Cut pipeline failures **60%** with a DAG pipeline on **Temporal**, running workers on **Kubernetes**." }, [{ kind: "bullet", id: "b1" }]);
  const madeUpNumber = edit("e2", { op: "rewrite_bullet", target: "b2", text: "Built REST services in **Node.js** serving 10M requests a day." }, [{ kind: "bullet", id: "b2" }]);
  const madeUpTech = edit("e3", { op: "rewrite_bullet", target: "b3", text: "Developed a **React** video editor deployed with **Terraform**." }, [{ kind: "bullet", id: "b3" }]);
  const r = checkEdits([good, madeUpNumber, madeUpTech], ix, profile, {});
  assert.deepEqual(r.passed.map((e) => e.id), ["e1"]);
  assert.match(r.failed.find((f) => f.edit.id === "e2")!.issues.join(), /numbers not in the evidence: 10M/);
  assert.match(r.failed.find((f) => f.edit.id === "e3")!.issues.join(), /mentions Terraform/);
});

test("a fact makes new tech legitimate, in bullets and skills", () => {
  const ix = indexDoc(doc, facts);
  const withFact = edit("e1", { op: "rewrite_bullet", target: "b1", text: "Designed a DAG pipeline on **Temporal**, cutting failures **60%**; provisioned its **Kubernetes** clusters with **Terraform**." }, [
    { kind: "bullet", id: "b1" },
    { kind: "fact", id: "f1" },
  ]);
  const skills = edit("e2", { op: "rewrite_skills", target: "s1", text: "Go, TypeScript, SQL, Terraform" });
  const unknownSkill = edit("e3", { op: "rewrite_skills", target: "s1", text: "Go, Rust, TypeScript" });
  const r = checkEdits([withFact, skills], ix, profile, {});
  assert.deepEqual(r.passed.map((e) => e.id), ["e1", "e2"]);
  const r2 = checkEdits([unknownSkill], ix, profile, {});
  assert.match(r2.failed[0].issues.join(), /adds skills with no evidence.*Rust/);
});

test("structure: unknown targets, full removals, bad reorders, duplicate targets", () => {
  const ix = indexDoc(doc, facts);
  const r = checkEdits(
    [
      edit("e1", { op: "remove_bullet", target: "b9" }),
      edit("e2", { op: "reorder_bullets", target: "l1", order: ["b3", "b1"] }),
      edit("e3", { op: "remove_bullet", target: "b2" }),
      edit("e4", { op: "remove_bullet", target: "b3" }),
      edit("e5", { op: "remove_bullet", target: "b1" }),
      edit("e6", { op: "rewrite_bullet", target: "b2", text: "Built REST services in **Node.js**." }, [{ kind: "bullet", id: "b2" }]),
      edit("e7", { op: "add_bullet", target: "l1", after: "b1", text: "Wrote Terraform for AKS." }),
    ],
    ix,
    profile,
    {},
  );
  const issues = Object.fromEntries(r.failed.map((f) => [f.edit.id, f.issues.join("; ")]));
  assert.match(issues.e1, /unknown bullet/);
  assert.match(issues.e2, /every bullet of the entry exactly once/);
  assert.match(issues.e5, /remove every bullet/);
  assert.match(issues.e6, /another edit already changes/);
  assert.match(issues.e7, /must cite a fact or bullet/);
  assert.deepEqual(r.passed.map((e) => e.id), ["e3", "e4"]);
});

test("virtual document and merging page-fit cuts", () => {
  const edits: Edit[] = [
    edit("e1", { op: "rewrite_bullet", target: "b2", text: "Built **Node.js** REST services." }, [{ kind: "bullet", id: "b2" }]),
    edit("e2", { op: "add_bullet", target: "l1", after: "b1", text: "Wrote **Terraform** for AKS." }, [{ kind: "fact", id: "f1" }]),
    edit("e3", { op: "reorder_bullets", target: "l1", order: ["b3", "b1", "b2"] }),
  ];
  const v = applyToDoc(doc, edits);
  assert.deepEqual(v.sections[0].lists[0].bullets.map((b) => b.id), ["b3", "b1", addedBulletId("e2"), "b2"]);
  assert.match(v.plainText, /Built Node.js REST services\./);

  const merged = mergeFitEdits(edits, [edit("e9", { op: "remove_bullet", target: "b2" }), edit("e10", { op: "remove_bullet", target: addedBulletId("e2") })], doc);
  assert.equal(merged.find((e) => e.id === "e1")!.change.op, "remove_bullet");
  assert.equal(merged.find((e) => e.id === "e2")!.status, "dropped");
});

test("a managed service proves its platform, not the other way round", () => {
  const ix = indexDoc(doc, []);
  // b1 runs workers on AKS (Azure); b2 is on AWS Lambda (AWS).
  const azure = edit("e1", { op: "rewrite_skills", target: "s1", text: "TypeScript, Go, Azure, AWS" });
  const bullet = edit("e2", { op: "rewrite_bullet", target: "b1", text: "Designed a **DAG-driven** pipeline on **Temporal**, cutting pipeline failures by **60%**; ran its workers on **Azure** (**AKS**)." }, [{ kind: "bullet", id: "b1" }]);
  assert.deepEqual(checkEdits([azure, bullet], ix, profile, {}).passed.map((e) => e.id), ["e1", "e2"]);
  // Azure doesn't prove AKS, and AWS isn't evidence for Google Cloud.
  const reverse = edit("e3", { op: "rewrite_skills", target: "s1", text: "TypeScript, Go, GKE" });
  assert.match(checkEdits([reverse], ix, profile, {}).failed[0].issues.join(), /Google Kubernetes Engine/);
});

test("fit: must-have coverage, weak counts half, missing years or degree caps it", async () => {
  const { assessFit } = await import("./fit.ts");
  const req = (id: string, kind: "must" | "nice", category = "language") => ({ id, text: id, kind, category, keywords: [] }) as JobProfile["requirements"][number];
  const p = (reqs: JobProfile["requirements"]) => ({ ...profile, requirements: reqs });
  const m = (pairs: [string, "strong" | "weak" | "missing"][]) => pairs.map(([requirementId, status]) => ({ requirementId, status, evidence: [], note: "" }));
  const four = [req("a", "must"), req("b", "must"), req("c", "must"), req("d", "must"), req("n", "nice")];
  assert.equal(assessFit(p(four), m([["a", "strong"], ["b", "strong"], ["c", "strong"], ["d", "weak"], ["n", "missing"]])).level, "strong");
  assert.equal(assessFit(p(four), m([["a", "strong"], ["b", "weak"], ["c", "missing"], ["d", "missing"]])).level, "long-shot");
  assert.equal(assessFit(p(four), m([["a", "strong"], ["b", "strong"], ["c", "missing"], ["d", "missing"]])).level, "stretch");
  const years = [req("a", "must"), req("b", "must"), req("c", "must"), req("y", "must", "experience")];
  const f = assessFit(p(years), m([["a", "strong"], ["b", "strong"], ["c", "strong"], ["y", "missing"]]));
  assert.deepEqual([f.level, f.hardGap, f.gaps], ["stretch", true, ["y"]], "75% covered, but the years requirement is missing");
});

test("a headline names the job's specialty or none", async () => {
  const { specialtyClash } = await import("./verify.ts");
  assert.deepEqual(specialtyClash("Software Engineer | Backend (TypeScript, Node.js, Go)", "full-stack"), { headline: "backend", role: "full-stack" });
  assert.equal(specialtyClash("Full-Stack Software Engineer", "full-stack"), null);
  assert.equal(specialtyClash("Software Engineer", "full-stack"), null, "no specialty is fine");
  assert.equal(specialtyClash("Backend & Infrastructure Engineer", "infrastructure"), null, "naming the role's own, among others, is fine");
  assert.deepEqual(specialtyClash("Backend Engineer", "platform"), { headline: "backend", role: "infrastructure" });
  const ix = indexDoc(doc, []);
  const r = checkEdits([edit("e1", { op: "set_headline", target: "h1", text: "Frontend Engineer" })], ix, profile, {});
  assert.match(r.failed[0].issues.join(), /headline says frontend but the role is backend/);
});

test("a headline is positioning: a role name is fine, a level must be shown by a role", () => {
  const roles = ["Northwind Labs, Pune Aug 2023 – Oct 2025 Software Development Engineer", "Acme Lending 2021 – 2023 Software Engineer"];
  for (const ok of ["Backend Engineer", "Software Development Engineer", "Full-Stack Engineer", "Platform Engineer"]) assert.equal(headlineLevelClaim(ok, roles), null, ok);
  assert.equal(headlineLevelClaim("Senior Backend Engineer", roles), "Senior");
  assert.equal(headlineLevelClaim("Staff Engineer", roles), "Staff");
  assert.equal(headlineLevelClaim("Tech Lead", roles), "Lead");
  assert.equal(headlineLevelClaim("Senior Engineer", ["Acme 2020 – now Sr. Software Engineer"]), null, "Sr. counts as Senior");
  assert.equal(headlineLevelClaim("Lead Backend Engineer", ["Foo — Lead Engineer"]), null);
});
