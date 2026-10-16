// Format-neutral operations on a ResumeDoc: a virtual "after" document for steps that need to see the
// draft (page fitting, coverage without a build), and merging page-fit cuts into the edit list.
import { plain } from "./text.ts";
import type { Edit, ResumeDoc } from "./types.ts";

/** Id of the bullet an add_bullet edit creates, in the virtual document. */
export const addedBulletId = (editId: string) => `n-${editId}`;

/** The document as it reads with these edits applied. Original ids are kept; added bullets get n-<edit>. */
export function applyToDoc(doc: ResumeDoc, edits: Edit[]): ResumeDoc {
  const d: ResumeDoc = structuredClone(doc);
  for (const e of edits) {
    if (e.status === "dropped") continue;
    const c = e.change;
    switch (c.op) {
      case "set_headline":
        if (d.headline?.id === c.target) d.headline.text = c.text;
        break;
      case "rewrite_paragraph":
        for (const s of d.sections) if (s.paragraph?.id === c.target) s.paragraph.text = c.text;
        break;
      case "rewrite_skills":
        for (const s of d.sections) for (const k of s.skills) if (k.id === c.target) k.text = c.text.replace(new RegExp(`^${escapeRe(k.label)}\\s*:\\s*`), "");
        break;
      case "rewrite_bullet":
        for (const s of d.sections) for (const l of s.lists) for (const b of l.bullets) if (b.id === c.target) b.text = c.text;
        break;
      case "remove_bullet":
        for (const s of d.sections) for (const l of s.lists) l.bullets = l.bullets.filter((b) => b.id !== c.target);
        break;
      case "add_bullet":
        for (const s of d.sections)
          for (const l of s.lists)
            if (l.id === c.target) {
              const at = c.after ? l.bullets.findIndex((b) => b.id === c.after) + 1 : 0;
              l.bullets.splice(at < 0 ? l.bullets.length : at, 0, { id: addedBulletId(e.id), text: c.text });
            }
        break;
      case "reorder_bullets":
        for (const s of d.sections)
          for (const l of s.lists)
            if (l.id === c.target) {
              const rank = new Map(c.order.map((id, i) => [id, i]));
              // Added bullets stay right after the bullet they were added after.
              const originals = l.bullets.filter((b) => rank.has(b.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
              const extras = l.bullets.filter((b) => !rank.has(b.id));
              l.bullets = originals;
              for (const x of extras) {
                const anchor = edits.find((ed) => addedBulletId(ed.id) === x.id && ed.change.op === "add_bullet");
                const after = anchor && anchor.change.op === "add_bullet" ? anchor.change.after : null;
                const at = after ? l.bullets.findIndex((b) => b.id === after) + 1 : 0;
                l.bullets.splice(at <= 0 && after ? l.bullets.length : at, 0, x);
              }
            }
        break;
    }
  }
  d.plainText = docText(d);
  return d;
}

/** Plain text of a document's editable and context content, in reading order. */
export function docText(doc: ResumeDoc): string {
  const out: string[] = [doc.header];
  if (doc.headline) out.push(plain(doc.headline.text));
  for (const s of doc.sections) {
    out.push(s.title);
    if (s.paragraph) out.push(plain(s.paragraph.text));
    for (const l of s.lists) {
      out.push(l.heading);
      for (const b of l.bullets) out.push(plain(b.text));
    }
    for (const k of s.skills) out.push(plain(`${k.label ? `${k.label}: ` : ""}${k.text}`));
    if (!s.lists.length && !s.skills.length && !s.paragraph && s.context) out.push(s.context);
  }
  return out.filter(Boolean).join("\n");
}

/**
 * Folds page-fit edits (written against the virtual document) into the edit list, so each target still
 * has one reviewable change: cutting a bullet you rewrote replaces the rewrite; shortening it updates the
 * rewrite's text; cutting an added bullet withdraws the addition.
 */
export function mergeFitEdits(edits: Edit[], fit: Edit[], original: ResumeDoc): Edit[] {
  const out = edits.map((e) => ({ ...e }));
  const originalBullets = new Set(original.sections.flatMap((s) => s.lists.flatMap((l) => l.bullets.map((b) => b.id))));
  for (const f of fit) {
    const c = f.change;
    if (c.op !== "remove_bullet" && c.op !== "rewrite_bullet") continue;
    const added = out.find((e) => addedBulletId(e.id) === c.target && e.change.op === "add_bullet");
    if (added) {
      if (c.op === "remove_bullet") {
        added.status = "dropped";
        added.issues = [...(added.issues ?? []), "cut to fit the page budget"];
      } else if (added.change.op === "add_bullet") {
        added.change = { ...added.change, text: c.text };
      }
      continue;
    }
    if (!originalBullets.has(c.target)) continue;
    const existing = out.find((e) => e.change.target === c.target && (e.change.op === "rewrite_bullet" || e.change.op === "remove_bullet") && e.status !== "dropped");
    const tagged: Edit = { ...f, reason: `${f.reason} (to fit the page budget)`, status: f.status ?? "ok" };
    if (!existing) out.push(tagged);
    else if (c.op === "remove_bullet") Object.assign(existing, tagged, { id: existing.id });
    else if (existing.change.op === "rewrite_bullet") existing.change = { ...existing.change, text: c.text };
  }
  return out;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
