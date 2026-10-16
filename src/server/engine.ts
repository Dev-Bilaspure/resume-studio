// Which TeX engine a document builds with. Pure, so it can be unit tested.
import type { Engine } from "../lib/types.ts";

/** `% !TEX program = xelatex` in the main file's first lines (the convention TeXShop/VS Code/Overleaf share). */
export function magicEngine(src: string): Engine | null {
  const m = /^%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(src.split("\n").slice(0, 10).join("\n"));
  const v = m?.[1].toLowerCase();
  return v === "pdflatex" || v === "xelatex" || v === "lualatex" || v === "latex" ? v : null;
}

function uncomment(src: string): string {
  return src
    .split("\n")
    .map((l) => l.replace(/(^|[^\\])%.*$/, "$1"))
    .join("\n");
}

const LOADS = (names: string) => new RegExp(`\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\b(?:${names})\\b`);

/** Class and package names the main file loads that may be files in the project (awesome-cv.cls). */
export function localDependencies(src: string): { classes: string[]; packages: string[] } {
  const code = uncomment(src.split(/\\begin\s*\{document\}/)[0]);
  const classes = [...code.matchAll(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].map((m) => m[1].trim());
  const packages = [...code.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()));
  return { classes, packages };
}

/**
 * The engine a document actually needs, as Overleaf users would have set it:
 *  - a "% !TEX program" line wins, then the main file's extension (.xtx is XeLaTeX's);
 *  - an engine you chose other than pdfLaTeX is kept;
 *  - otherwise (pdfLaTeX, the default) the preamble decides, including the project's own .cls/.sty
 *    files it loads (`related`): fontspec / unicode-math / polyglossia need XeLaTeX (or LuaLaTeX),
 *    Lua code needs LuaLaTeX, and PSTricks needs the DVI route (LaTeX).
 */
export function effectiveEngine(src: string, configured: Engine, mainFile = "main.tex", related: string[] = []): Engine {
  const magic = magicEngine(src);
  if (magic) return magic;
  if (/\.xtx$/i.test(mainFile)) return "xelatex";
  if (configured !== "pdflatex") return configured;
  const code = [uncomment(src.split(/\\begin\s*\{document\}/)[0]), ...related.map(uncomment)].join("\n");
  if (LOADS("luacode|luatexja|luaotfload|lua-visual-debug|luatextra").test(code) || /\\directlua\b/.test(code)) return "lualatex";
  if (LOADS("fontspec|unicode-math|polyglossia|xeCJK|xltxtra|xunicode").test(code)) return "xelatex";
  if (LOADS("pstricks|pst-[a-z-]+").test(code) && !LOADS("auto-pst-pdf|pstool").test(code)) return "latex";
  return configured;
}

const MAIN_EXT = /\.(tex|xtx|ltx)$/i;

/**
 * Orders candidate main files (paths of files containing \\documentclass) best first, the way you'd pick
 * the document in a template repository: main/resume/cv/template/sample by name, not a manual, legacy
 * copy or cover letter, and closer to the top.
 */
export function rankMainCandidates(paths: string[]): string[] {
  const NAMES = ["main", "resume", "cv", "template", "sample", "example"];
  const score = (p: string) => {
    const name = (p.split("/").pop() ?? p).replace(MAIN_EXT, "").toLowerCase();
    const exact = NAMES.indexOf(name);
    let s = exact >= 0 ? exact : /resume|cv/.test(name) ? 6 : 8;
    if (/(^|\/)(manual|doc|docs|documentation|legacy|old|test|tests|archive|backup|deprecated)\//i.test(p)) s += 20;
    if (/cover.?letter|letter/i.test(name)) s += 5;
    if (/\.ltx$/i.test(p)) s += 1;
    return s * 10 + p.split("/").length;
  };
  return [...paths].filter((p) => MAIN_EXT.test(p)).sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

/**
 * Fonts a document asks fontspec for by name (\setmainfont{Roboto}, \newfontfamily\x{Lato Light}…).
 * Fonts loaded by file name ("Lato-Regular.ttf", Path=…, Extension=…) are left out: XeLaTeX finds those
 * through TeX's own file search on every system.
 */
export function requestedFonts(code: string): string[] {
  const src = uncomment(code);
  const out: string[] = [];
  const re =
    /\\(?:setmainfont|setsansfont|setmonofont|setmathfont|fontspec|setfontfamily|newfontfamily|renewfontfamily|newfontface|renewfontface)\s*(?:\\[A-Za-z@]+|\{\\[A-Za-z@]+\})?\s*(\[[^\]]*\])?\s*\{([^}]+)\}\s*(\[[^\]]*\])?/g;
  for (const m of src.matchAll(re)) {
    const name = m[2].trim();
    const opts = `${m[1] ?? ""}${m[3] ?? ""}`;
    if (!name || /[\\#]/.test(name) || /\.(otf|ttf|ttc|pfb)$/i.test(name) || /\b(Path|Extension)\s*=/.test(opts)) continue;
    out.push(name);
  }
  return [...new Set(out)];
}

/** "Roboto Slab", "RobotoSlab-Regular" → "robotoslab…": compares names the way font menus differ. */
export function fontKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Packages that only work with XeTeX: a document loading them can't fall back to LuaLaTeX. */
export function needsXeTeX(code: string): boolean {
  return (
    LOADS("xltxtra|xunicode|xeCJK|xecjk|xepersian|xetexko|xeindex|xesearch|xecolor|xgreek|xltabular-xetex").test(uncomment(code)) ||
    /\\XeTeXinterchartoks|\\XeTeXlinebreaklocale/.test(code)
  );
}
