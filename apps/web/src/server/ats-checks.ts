// ATS readiness checks. Pure: takes what the PDF tools extracted plus the LaTeX source, returns checks
// and a score. An ATS (Workday, Greenhouse, Lever, iCIMS, Taleo...) converts the PDF to plain text and
// parses that, so most checks look at exactly that text: what isn't in it, or is garbled in it, is
// invisible to keyword search and to the recruiter's filters.
import type { AtsCategory, AtsCheck, AtsReport, AtsStatus, FontInfo } from "../lib/types.ts";

export interface AtsInput {
  text: string; // pdftotext output (reading order)
  /** pdftotext -layout output (physical lines), to detect text that reading order separates. */
  layoutText?: string;
  pages: number;
  fileSizeKB: number;
  fonts: FontInfo[];
  title: string | null;
  author: string | null;
  /** The resume's text sources, by relative path (for source-level checks with line numbers). */
  sources: Record<string, string>;
  mainFile: string;
}

const W: Record<string, number> = {
  "text-extractable": 30,
  "unicode-map": 18,
  "contact-email": 14,
  "section-experience": 12,
  columns: 10,
  "reading-order": 8,
  icons: 8,
  ligatures: 8,
  garbled: 10,
  "fonts-embedded": 6,
  type3: 6,
  hyphenation: 6,
  images: 4,
  "contact-phone": 4,
  "section-education": 4,
  "section-skills": 4,
  pages: 5,
  tables: 3,
  "header-footer": 3,
  words: 3,
  "contact-position": 3,
  "contact-linkedin": 2,
  metadata: 2,
  dates: 2,
  size: 2,
  quantified: 0, // advice only; doesn't affect machine readability
};

const HEADINGS = {
  experience: /^(work |professional |relevant )?(experience|employment( history)?|work history|career history)$/i,
  education: /^(education|academic background|education & training|education and training)$/i,
  skills: /^((technical |core |key )?skills|skills & tools|technologies|technical proficiencies|core competencies)$/i,
};

/** Line numbers (1-based) where a regex matches outside comments, across all sources. */
function findInSources(sources: Record<string, string>, re: RegExp): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const [file, src] of Object.entries(sources)) {
    const lines = src.split("\n");
    lines.forEach((raw, i) => {
      const code = stripComment(raw);
      if (re.test(code)) hits.push({ file, line: i + 1, text: raw.trim() });
    });
  }
  return hits;
}

/** Removes a TeX comment (unescaped %) from a line. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "%" && (i === 0 || line[i - 1] !== "\\")) return line.slice(0, i);
  }
  return line;
}

function sample(items: string[], n = 3): string {
  const uniq = [...new Set(items)];
  return (
    uniq
      .slice(0, n)
      .map((s) => `“${s}”`)
      .join(", ") + (uniq.length > n ? `, and ${uniq.length - n} more` : "")
  );
}

export function runAtsChecks(input: AtsInput): AtsReport {
  const checks: AtsCheck[] = [];
  const add = (id: string, category: AtsCategory, title: string, status: AtsStatus, detail: string, extra: Partial<AtsCheck> = {}) =>
    checks.push({ id, category, title, status, detail, ...extra });

  const text = input.text.normalize("NFC");
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.+#-]*/gu) ?? []).length;
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const head = text.slice(0, Math.max(400, Math.floor(text.length * 0.2)));

  // ---- Parsing: can a machine read it at all? --------------------------------------------------------
  if (words < 40) {
    add(
      "text-extractable",
      "parsing",
      "Text can be extracted",
      "fail",
      `Only ${words} words could be extracted from the PDF. An ATS will see an almost empty resume.`,
      { fix: "Don't render text as images or paths. Use real fonts (T1 + lmodern/XCharter with pdflatex, or fontspec with xelatex/lualatex)." },
    );
  } else {
    add("text-extractable", "parsing", "Text can be extracted", "pass", `${words} words extracted.`);
  }

  // Icon fonts are covered by the icon check below; Type 3 by the bitmap-font check.
  const isIconFont = (f: FontInfo) => /FontAwesome|academicons|marvosym|Dingbat|ZapfDingbats|fontawesome/i.test(f.name);
  const noUnicode = input.fonts.filter((f) => !f.unicodeMap && !/Type 3/.test(f.type) && !isIconFont(f));
  if (noUnicode.length) {
    add(
      "unicode-map",
      "parsing",
      "Every font maps to Unicode",
      "fail",
      `${noUnicode.length} font(s) have no Unicode mapping (${sample(noUnicode.map((f) => f.name))}); their text may extract as garbage.`,
      { fix: "With pdflatex add \\input{glyphtounicode} and \\pdfgentounicode=1 to the preamble, and use \\usepackage[T1]{fontenc}." },
    );
  } else {
    add("unicode-map", "parsing", "Every font maps to Unicode", "pass", "All fonts carry a ToUnicode map.");
  }

  const garbled = text.match(/[�\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? [];
  if (garbled.length) {
    add("garbled", "parsing", "No unreadable characters", "fail", `${garbled.length} character(s) extract as unknown symbols (�).`, {
      fix: "Usually a font without a Unicode map, or a symbol from a dingbat font. Replace symbols with words.",
    });
  } else {
    add("garbled", "parsing", "No unreadable characters", "pass", "No unknown characters in the extracted text.");
  }

  const ligs = text.match(/\S*[ﬀ-ﬆ]\S*/g) ?? [];
  if (ligs.length) {
    add(
      "ligatures",
      "parsing",
      "No ligature characters",
      "warn",
      `Words like ${sample(ligs)} contain a ligature character, so a search for the plain word may not match.`,
      { fix: "Add \\usepackage{microtype} and \\DisableLigatures[f]{encoding = *, family = *}, or keep \\input{glyphtounicode} + \\pdfgentounicode=1." },
    );
  } else {
    add("ligatures", "parsing", "No ligature characters", "pass", "fi, fl, ff extract as separate letters.");
  }

  const pua = text.match(/[-]|[\u{F0000}-\u{FFFFD}]/gu) ?? [];
  const iconSrc = findInSources(input.sources, /\\usepackage(\[[^\]]*\])?\{(fontawesome5?|academicons|marvosym|fontawesome)\}|\\fa[A-Z][A-Za-z]*\b|\\faIcon/);
  if (pua.length || iconSrc.some((h) => !/\\usepackage/.test(h.text))) {
    const first = iconSrc.find((h) => !/\\usepackage/.test(h.text)) ?? iconSrc[0];
    add(
      "icons",
      "parsing",
      "No icon glyphs",
      "warn",
      pua.length
        ? `${pua.length} icon glyph(s) extract as private-use characters that mean nothing to an ATS.`
        : "Icon commands are used; icons extract as meaningless characters.",
      { fix: 'Label contact details with words or nothing ("alex@x.com | linkedin.com/in/alex") instead of icons.', file: first?.file, line: first?.line },
    );
  } else {
    add("icons", "parsing", "No icon glyphs", "pass", "No icon fonts or symbols.");
  }

  const notEmbedded = input.fonts.filter((f) => !f.embedded);
  add(
    "fonts-embedded",
    "parsing",
    "All fonts embedded",
    notEmbedded.length ? "warn" : "pass",
    notEmbedded.length
      ? `Not embedded: ${sample(notEmbedded.map((f) => f.name))}. The PDF may look different, and extract differently, elsewhere.`
      : `${input.fonts.length} font(s), all embedded.`,
    notEmbedded.length ? { fix: "Use T1-encoded vector fonts (lmodern, XCharter, sourcesanspro); pdflatex embeds them." } : {},
  );

  const type3 = input.fonts.filter((f) => /Type 3/.test(f.type));
  add(
    "type3",
    "parsing",
    "No bitmap (Type 3) fonts",
    type3.length ? "warn" : "pass",
    type3.length
      ? `${type3.length} bitmap font(s): ${sample(type3.map((f) => f.name))}. They render blurry and often extract poorly.`
      : "All fonts are outline fonts.",
    type3.length
      ? { fix: "Load \\usepackage{lmodern} (or another vector font) after \\usepackage[T1]{fontenc}; install cm-super if you need Computer Modern in T1." }
      : {},
  );

  const hyph = [...text.matchAll(/([A-Za-z]{2,})-\n\s*([a-z]{2,})/g)].map((m) => `${m[1]}-${m[2]}`);
  add(
    "hyphenation",
    "parsing",
    "No words split across lines",
    hyph.length ? "warn" : "pass",
    hyph.length
      ? `${hyph.length} word(s) hyphenated at a line break, e.g. ${sample(hyph)}. An ATS reads these as two fragments.`
      : "No hyphenated line breaks.",
    hyph.length ? { fix: "Add \\hyphenpenalty=10000 and \\exhyphenpenalty=10000 (with \\raggedright) to the preamble." } : {},
  );

  // ---- Structure: can it find the sections and your contact details? ---------------------------------
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text);
  add(
    "contact-email",
    "structure",
    "Email address",
    email ? "pass" : "fail",
    email ? `Found ${email[0]}.` : "No email address in the extracted text.",
    email ? {} : { fix: "Put your email in the header as visible text, not only as a link or an icon." },
  );

  // A phone number: 7–15 digits in groups (not a year range or a metric like "12k requests").
  const phone = [...text.matchAll(/(\+?\d{1,3}[\s.-]?)?(\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g)]
    .map((m) => m[0].trim())
    .find((p) => {
      const digits = p.replace(/\D/g, "").length;
      return digits >= 7 && digits <= 15 && !/^(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}$/.test(p);
    });
  if (phone && /\n/.test(phone)) {
    add(
      "contact-phone",
      "structure",
      "Phone number",
      "warn",
      `Your phone number is split across two lines (“${phone.replace(/\s*\n\s*/, " ⏎ ")}”), so a parser may not recognise it.`,
      { fix: "Keep it on one line: write (415)~555-0134 with ~ (a non-breaking space), or wrap each contact item in \\mbox{…}." },
    );
  } else {
    add(
      "contact-phone",
      "structure",
      "Phone number",
      phone ? "pass" : "warn",
      phone ? `Found ${phone}.` : "No phone number found. Many ATS forms and recruiters expect one.",
      phone ? {} : { fix: "Add a phone number to the header." },
    );
  }

  const linkedin = /linkedin\.com\/in\/[A-Za-z0-9_-]+/i.exec(text);
  add(
    "contact-linkedin",
    "structure",
    "LinkedIn URL",
    linkedin ? "pass" : "warn",
    linkedin ? `Found ${linkedin[0]}.` : "No linkedin.com/in/… URL as visible text.",
    linkedin ? {} : { fix: 'Show the URL as text (linkedin.com/in/you); a hyperlink on the word "LinkedIn" is lost when the PDF is converted to text.' },
  );

  if (email) {
    const inHead = email.index < head.length;
    add(
      "contact-position",
      "structure",
      "Contact details at the top",
      inHead ? "pass" : "warn",
      inHead ? "Contact details are in the first part of the text." : "Your email first appears far down the extracted text.",
      inHead ? {} : { fix: "Keep contact details in the body at the top, not in a sidebar, footer or \\fancyhead." },
    );
  }

  const found = (re: RegExp) => lines.some((l) => re.test(l.replace(/[:\s]+$/, "")));
  add(
    "section-experience",
    "structure",
    "“Experience” section",
    found(HEADINGS.experience) ? "pass" : "fail",
    found(HEADINGS.experience)
      ? "A standard experience heading was found."
      : "No standard heading such as “Experience” or “Work Experience”. ATS parsers locate jobs by this heading.",
    found(HEADINGS.experience) ? {} : { fix: "Name the section “Experience” (or “Work Experience”, “Professional Experience”)." },
  );
  add(
    "section-education",
    "structure",
    "“Education” section",
    found(HEADINGS.education) ? "pass" : "warn",
    found(HEADINGS.education) ? "A standard education heading was found." : "No “Education” heading found.",
    found(HEADINGS.education) ? {} : { fix: "Add an “Education” section, even a one-line one." },
  );
  add(
    "section-skills",
    "structure",
    "“Skills” section",
    found(HEADINGS.skills) ? "pass" : "warn",
    found(HEADINGS.skills) ? "A standard skills heading was found." : "No “Skills” heading. Skills sections are where keyword matching is strongest.",
    found(HEADINGS.skills) ? {} : { fix: "Add a “Skills” section listing tools and technologies by name." },
  );

  // ---- Formatting: layout features that ATS parsers commonly mangle -----------------------------------
  const cols = findInSources(input.sources, /\\begin\{(multicols\*?|paracol)\}|\\usepackage(\[[^\]]*\])?\{(multicol|paracol)\}/).filter(
    (h) => !/\\usepackage/.test(h.text),
  );
  const minipages = findInSources(input.sources, /\\begin\{minipage\}/);
  if (cols.length || minipages.length >= 2) {
    const first = cols[0] ?? minipages[0];
    add(
      "columns",
      "formatting",
      "Single-column layout",
      "warn",
      "Multi-column layout detected. Many parsers read straight across both columns, mixing your jobs, dates and skills.",
      { fix: "Use one column. Put dates on the right of the job title line with \\hfill instead of a second column.", file: first.file, line: first.line },
    );
  } else {
    add("columns", "formatting", "Single-column layout", "pass", "One column: reading order is unambiguous.");
  }

  if (input.layoutText) {
    const split = readingOrderSplits(text, input.layoutText);
    add(
      "reading-order",
      "formatting",
      "Right-aligned details stay with their entry",
      split.length ? "warn" : "pass",
      split.length
        ? `${split.length} right-aligned item(s) are read far away from the line they sit on, e.g. ${sample(
            split.map((x) => `${x.right}” beside “${x.left}`),
            2,
          )}. An ATS may not connect these dates/places to the right job or degree.`
        : "Text aligned to the right (dates, locations) is read together with its line.",
      split.length
        ? {
            fix: "Right-aligned text with nothing full-width below it is read as a separate column. Put it inline (B.S. Computer Science, UC Berkeley | 2014 – 2018), or keep right-aligned dates only on lines followed by bullet points.",
          }
        : {},
    );
  }

  const tables = findInSources(input.sources, /\\begin\{(tabular\*?|tabularx|tabulary|longtable|tblr)\}/);
  add(
    "tables",
    "formatting",
    "No layout tables",
    tables.length ? "warn" : "pass",
    tables.length ? `${tables.length} table(s). Text in table cells is often extracted out of order or dropped.` : "No tables.",
    tables.length
      ? { fix: "Use plain lines with \\hfill for right-aligned dates, and simple lists for skills.", file: tables[0].file, line: tables[0].line }
      : {},
  );

  const images = findInSources(input.sources, /\\includegraphics|\\begin\{tikzpicture\}|\\tikz\b/);
  add(
    "images",
    "formatting",
    "No images or graphics",
    images.length ? "warn" : "pass",
    images.length ? "Images, logos, skill bars and charts carry no text an ATS can read; photos are discouraged in many countries." : "No images or drawings.",
    images.length ? { fix: "Replace graphics with text (e.g. skill levels as words).", file: images[0].file, line: images[0].line } : {},
  );

  const hf = findInSources(input.sources, /\\fancy(head|foot)|\\lhead|\\rhead|\\chead|\\lfoot|\\rfoot|\\cfoot/).filter((h) => /\{[^}]*\S[^}]*\}/.test(h.text));
  add(
    "header-footer",
    "formatting",
    "Nothing important in page header/footer",
    hf.length ? "warn" : "pass",
    hf.length ? "Content in the page header or footer. Some ATS parsers skip headers and footers entirely." : "No running header or footer content.",
    hf.length ? { fix: "Keep name and contact details in the document body.", file: hf[0].file, line: hf[0].line } : {},
  );

  add(
    "pages",
    "formatting",
    "Length",
    input.pages <= 2 ? "pass" : "warn",
    input.pages <= 2 ? `${input.pages} page${input.pages === 1 ? "" : "s"}.` : `${input.pages} pages. Recruiters expect one page (two for senior roles).`,
    input.pages <= 2 ? {} : { fix: "Cut older or less relevant roles to one line each." },
  );

  add(
    "words",
    "formatting",
    "Amount of text",
    words < 200 ? "warn" : words > 1100 ? "warn" : "pass",
    words < 200
      ? `${words} words: too thin to match many keywords.`
      : words > 1100
        ? `${words} words: dense; skimming recruiters miss things.`
        : `${words} words.`,
  );

  const titleOk = !!input.title && !/^(main|untitled|resume)(\.tex)?$/i.test(input.title.trim());
  add(
    "metadata",
    "formatting",
    "PDF title and author",
    titleOk && input.author ? "pass" : "warn",
    titleOk && input.author
      ? `Title “${input.title}”, author “${input.author}”.`
      : "The PDF has no meaningful title/author; some portals show the title (e.g. “main”) to recruiters.",
    titleOk && input.author ? {} : { fix: "\\hypersetup{pdftitle={Your Name — Resume}, pdfauthor={Your Name}}" },
  );

  add(
    "size",
    "formatting",
    "File size",
    input.fileSizeKB > 2048 ? "warn" : "pass",
    `${input.fileSizeKB.toLocaleString()} KB${input.fileSizeKB > 2048 ? ": some application portals reject files over 2 MB." : "."}`,
  );

  const formats = {
    "Mon YYYY": /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? (19|20)\d{2}\b/g,
    "MM/YYYY": /\b(0?[1-9]|1[0-2])\/(19|20)\d{2}\b/g,
    "YYYY-MM": /\b(19|20)\d{2}-(0[1-9]|1[0-2])\b/g,
  };
  const used = Object.entries(formats)
    .filter(([, re]) => (text.match(re) ?? []).length > 0)
    .map(([k]) => k);
  add(
    "dates",
    "formatting",
    "Consistent date format",
    used.length > 1 ? "warn" : "pass",
    used.length > 1
      ? `Mixed date formats: ${used.join(", ")}. Parsers compute experience length from these.`
      : used.length
        ? `Dates use ${used[0]}.`
        : "No month-year dates found.",
    used.length > 1 ? { fix: "Use one format everywhere, e.g. “Mar 2022 – Present”." } : {},
  );

  // ---- Content advice (no score impact) ----------------------------------------------------------------
  const bullets = bulletPoints(text);
  if (bullets.length) {
    const withNumbers = bullets.filter((b) => /\d/.test(b)).length;
    const share = withNumbers / bullets.length;
    add(
      "quantified",
      "content",
      "Quantified impact",
      share >= 0.5 ? "pass" : "warn",
      `${withNumbers} of ${bullets.length} bullet points contain a number (${Math.round(share * 100)}%).`,
      share >= 0.5 ? {} : { fix: "Lead bullets with a measurable result: latency, revenue, cost, users, time saved, team size." },
    );
  }

  let score = 100;
  for (const c of checks) {
    const w = W[c.id] ?? 0;
    if (c.status === "fail") score -= w;
    else if (c.status === "warn") score -= w / 2;
  }

  return {
    score: Math.max(0, Math.round(score)),
    checks,
    text: input.text,
    stats: { pages: input.pages, words, fileSizeKB: input.fileSizeKB, fonts: input.fonts, title: input.title, author: input.author },
  };
}

/** Bullet points with their wrapped continuation lines joined back on. */
export function bulletPoints(text: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    if (/^\s*[•▪◦‣∙·*–-]\s+\S/.test(line)) {
      if (cur !== null) out.push(cur);
      cur = line.trim();
    } else if (cur !== null && line.trim() && !/^\s*[A-Z][A-Za-z &]{2,40}$/.test(line)) {
      cur += " " + line.trim(); // continuation of the bullet (not a blank line or a heading)
    } else if (cur !== null) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * Pairs [left, right] from physical lines with a wide gap ("Title        Mar 2022 – Present") whose
 * right part shows up more than a few lines away from the left part in reading-order text: the parser
 * treated the right-aligned text as a separate column.
 */
export function readingOrderSplits(text: string, layoutText: string): { left: string; right: string }[] {
  const raw = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const indexes = (frag: string) => raw.flatMap((l, i) => (l.includes(frag) ? [i] : []));
  const out: { left: string; right: string }[] = [];
  for (const line of layoutText.split("\n")) {
    const parts = line
      .trim()
      .split(/\s{4,}/)
      .filter((p) => p.trim().length >= 3);
    if (parts.length < 2) continue;
    const left = parts[0].slice(0, 40);
    const right = parts[parts.length - 1].slice(0, 40);
    const as = indexes(left);
    const bs = indexes(right);
    if (!as.length || !bs.length) continue;
    // Fine if any occurrence of the left part (it may also appear in the header) has the right part
    // within a few lines of it.
    const together = as.some((a) => bs.some((b) => b >= a - 1 && b - a <= 3));
    if (!together) out.push({ left: parts[0].trim(), right: parts[parts.length - 1].trim() });
  }
  return out;
}

/**
 * Parses `pdffonts` output. Columns are fixed-width, but a long font name overflows its column and
 * shifts the rest of the row, so each row is read from the right: object ID (2 numbers), uni, sub, emb,
 * encoding (one word); the first word is the name, whatever is in between is the type ("CID Type 0C").
 */
export function parsePdffonts(out: string): FontInfo[] {
  const lines = out.split("\n");
  const dashIdx = lines.findIndex((l) => /^-{4,}/.test(l));
  if (dashIdx < 0) return [];
  const fonts: FontInfo[] = [];
  for (const row of lines.slice(dashIdx + 1)) {
    const t = row.trim().split(/\s+/);
    if (t.length < 8) continue;
    const [uni, , emb] = t.slice(-5, -2).reverse();
    fonts.push({
      name: t[0].replace(/^[A-Z]{6}\+/, "").replace(/-Identity-[HV]$/, ""), // drop the subset prefix "ABCDEF+"
      type: t.slice(1, -6).join(" "),
      embedded: emb === "yes",
      unicodeMap: uni === "yes",
    });
  }
  return fonts;
}

/** Parses `pdfinfo` output ("Key:   value" lines). */
export function parsePdfinfo(out: string): Record<string, string> {
  const info: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) info[m[1].trim()] = m[2].trim();
  }
  return info;
}
