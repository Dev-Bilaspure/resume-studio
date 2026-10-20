// Text helpers shared by the engine and format adapters: the light markup, numbers, and coverage.
import { mentions } from "./lexicon.ts";
import type { Coverage, Keyword, RequirementMatch } from "./types.ts";

// ---- Light markup: **bold**, *italic*, [text](url) ----------------------------------------------------------

/** The markup with formatting removed: what a reader (or an ATS) sees. */
export function plain(markup: string): string {
  return markup
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Problems with markup a model wrote: unbalanced markers, stray LaTeX, nested links. */
export function markupProblems(markup: string): string[] {
  const out: string[] = [];
  const withoutLinks = markup.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  if ((withoutLinks.match(/\*\*/g) ?? []).length % 2) out.push("unbalanced ** (bold)");
  const singles = withoutLinks.replace(/\*\*/g, "").match(/\*/g) ?? [];
  if (singles.length % 2) out.push("unbalanced * (italic)");
  if (/\\[A-Za-z]+/.test(markup)) out.push("contains a LaTeX command; use **bold** / *italic* markup instead");
  if (/[{}]/.test(withoutLinks)) out.push("contains { or }");
  if (/\n/.test(markup.trim())) out.push("spans several lines");
  return out;
}

// ---- Numbers --------------------------------------------------------------------------------------------

/**
 * Numbers in a text, normalized so "60%", "60 %" and "60 percent" match; "1,350" and "1350" match;
 * "3B" and "3 billion" match; "120ms" and "120 ms" match. Years (1990–2039) are included: they're claims
 * too (dates), so a rewrite can't move them.
 */
export function numbers(text: string): string[] {
  const t = plain(text)
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/\s*percent\b/gi, "%")
    .replace(/(\d)\s+%/g, "$1%")
    .replace(/(\d+(?:\.\d+)?)\s*(billion|bn)\b/gi, "$1B")
    .replace(/(\d+(?:\.\d+)?)\s*(million|mm)\b/gi, "$1M")
    .replace(/(\d+(?:\.\d+)?)\s*(thousand)\b/gi, "$1K")
    .replace(/(\d)\s+(ms|s|x|k|K|M|B|GB|TB|MB|PB|req|rps|qps)\b/g, "$1$2");
  const found = t.match(/\d+(?:\.\d+)?(?:%|[kKMB]|x|ms|GB|TB|MB|PB)?\+?/g) ?? [];
  return [...new Set(found.map((n) => n.replace(/\+$/, "").replace(/k$/, "K")))];
}

/** Numbers in `text` that appear in none of the sources (a number can't come from nowhere). */
export function unsupportedNumbers(text: string, sources: string[]): string[] {
  const allowed = new Set(sources.flatMap(numbers));
  // A bare number is supported by any unit form of itself in the sources ("60" by "60%").
  const bare = new Set([...allowed].map((n) => n.replace(/[^\d.]/g, "")));
  return numbers(text).filter((n) => !allowed.has(n) && !(/^\d+(\.\d+)?$/.test(n) && bare.has(n)));
}

// ---- Coverage -------------------------------------------------------------------------------------------

/** Which must-have keywords a text mentions (counting aliases), and the requirement match counts. */
export function coverage(text: string, keywords: Keyword[], matches: RequirementMatch[]): Coverage {
  // Concepts ("distributed systems") are shown by the work, not by the word: they're covered by
  // requirement matching. Keyword coverage is about the searchable terms.
  const must = keywords.filter((k) => k.importance === "must" && (k.kind ?? "term") === "term");
  const found = must.filter((k) => mentions(text, k.term, k.aliases)).map((k) => k.term);
  return {
    requirementsStrong: matches.filter((m) => m.status === "strong").length,
    requirementsWeak: matches.filter((m) => m.status === "weak").length,
    requirementsMissing: matches.filter((m) => m.status === "missing").length,
    requirementsTotal: matches.length,
    keywordsFound: found,
    keywordsMissing: must.filter((k) => !found.includes(k.term)).map((k) => k.term),
  };
}

let counter = 0;
/** Short unique ids: "f-lq3k2-1". */
export function uid(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
