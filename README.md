# Resume Studio

A local LaTeX resume editor: code on the left, the real PDF on the right, rebuilt on every save, with a
built-in ATS (applicant tracking system) check of what a parser actually extracts from your PDF.
Everything runs on this Mac; your resumes are plain `.tex` files you own.

## Setup

```sh
brew install --cask mactex-no-gui   # full TeX Live (same as Overleaf); needs your password
brew install poppler                # pdftotext/pdffonts/pdfinfo for the ATS check
pnpm install
pnpm dev                            # http://127.0.0.1:4317
```

Production mode: `pnpm build && pnpm start`. The server only answers on 127.0.0.1.

## Where things live

```
resumes/<name>/          your resumes: main.tex (+ any \input files, .cls, images) and resume.json
.resume-studio/          app state, safe to delete except git/ (your snapshot history)
  build/<name>/          latexmk aux files (incremental builds)
  publish/<name>/        the PDFs the preview shows (last few builds)
  git/                   snapshot history (a git repo the app owns; it never touches this repo)
  trash/                 deleted resumes (move a folder back into resumes/ to recover it)
```

Both are git-ignored. Override the location with `RESUME_STUDIO_ROOT=/some/dir`. Folders you create
under `resumes/` yourself appear automatically; edits from other editors are picked up live.

## Coming from Overleaf

Overleaf → Menu → Download → **Source** gives a .zip; on the home page click **Import .zip**. The main
file and the compiler are detected (a preamble with `fontspec` builds with XeLaTeX, as it must). Project
menu (⋯) → **Download source (.zip)** goes the other way.

Same as Overleaf: TeX Live 2026 via latexmk; pdfLaTeX, XeLaTeX, LuaLaTeX and LaTeX (DVI); biber/BibTeX,
makeindex, glossaries/acronyms, nomenclature; EPS images; `\input`/`\include` across folders; main
document setting; auto compile; stop on first error; clear cached files; raw logs and output files; word
count; SyncTeX both ways; find in the PDF. Editor: completion for commands, environments, `\ref` labels,
`\cite` keys, file names and packages; `\begin{…}` closes itself; folding; file outline; spell check;
font size, line wrap, Vim and Emacs keys.

Not here: real-time collaboration, comments/track changes and the rich-text visual editor.

**How it picks the engine** (unless you set one): `% !TEX program = …` wins; `.xtx` files are XeLaTeX;
`fontspec`/`unicode-math`/`polyglossia` in the preamble *or in the project's own .cls/.sty* → XeLaTeX;
Lua code → LuaLaTeX; PSTricks → LaTeX (DVI). XeLaTeX on macOS can only find fonts installed in macOS
by name, not the ones in TeX Live (Roboto, Source Sans 3, Lato…) that Overleaf's Linux XeLaTeX finds;
documents that ask for such fonts are built with LuaLaTeX, which finds them, unless they load XeTeX-only
packages. The build's info note and the status bar say when this happened.

**Like Overleaf's compile servers**, TeX runs in the main file's folder (`latexmk -cd`) and carries on past
errors (`latexmk -f`) unless "Stop on first error" is on. BibTeX/biber problems from the `.blg` (bad
entries with their `.bib` line, missing keys) are listed in Problems. Imported archives keep symlinks that
point inside the project as copies (e.g. Awesome-CV's `examples/awesome-cv.cls`).

Tested with Jake's Resume, Awesome-CV, Deedy, moderncv and AltaCV as they ship on GitHub: all build
without errors.

**Trusted projects.** Overleaf runs every project with shell escape inside a sandbox. Here, a `.tex`
file runs on your Mac, so by default TeX gets its *restricted* shell escape (only vetted helpers such as
`epstopdf`) and a project's `latexmkrc` is ignored. Settings → Compiler → **Trusted project** enables
`-shell-escape` (minted, svg, gnuplot) and the project `latexmkrc` for projects you trust.

## How it works

- **Compile**: `latexmk` with pdfLaTeX, XeLaTeX, LuaLaTeX or LaTeX → DVI → PDF (per resume, or
  `% !TEX program = xelatex` in the main file). Like Overleaf's compile servers, a build runs in a mirror
  of the project under `.resume-studio/build/`, so every helper sees relative paths, TeX's write
  protection stays on and generated files never land in your folder. Builds are incremental, coalesced
  while you type (never killed half-way) and time out after 120 s. Each build's PDF is published
  atomically under a new id, so the preview never sees a half-written file.
- **Preview**: PDF.js with two stacked viewers. A new build renders in the hidden one at the same zoom
  and scroll position, then they swap, so there is no flicker or jump. A failed build keeps the last good PDF
  on screen (the partial output is one click away).
- **Problems**: the TeX log is parsed into errors, warnings and layout notes (text overflowing the margin)
  with jump-to-line; errors inside a package point at the `\usepackage` line that loaded it.
- **SyncTeX**: ⌘J shows the cursor's line in the PDF; double-click the PDF to jump to the source.
- **Saving**: autosave (toggle in settings) or ⌘S. Saves are atomic and refuse to overwrite a file that
  changed on disk since you opened it; you choose which version to keep.
- **Snapshots**: automatic (after good builds, at most every 10 minutes) and named, with labels like
  `sent-to-acme`. View any snapshot's PDF without restoring, compare it side by side, or restore it (the
  current version is snapshotted first, so a restore can be undone).

## The ATS check

After each successful build the PDF is converted to text the way ATS parsers do it (`pdftotext`, reading
order and physical layout) and checked:

- **Machine readability**: text extractable, every font has a Unicode map, no garbled characters, no
  ligature glyphs (`ﬁ`), no icon glyphs, fonts embedded, no bitmap Type 3 fonts, no hyphenated words.
- **Sections & contact**: email, phone (and not split across lines), LinkedIn URL as visible text, contact
  details at the top, standard Experience / Education / Skills headings.
- **Layout**: single column, right-aligned text (dates) read together with its line, no layout tables,
  images or header/footer content, length, PDF title/author, consistent date formats, file size.
- **Content** (advice, not scored): share of bullet points with a measurable result.

"What the ATS reads" shows the extracted text, with a keyword finder.

The templates (Classic, Modern, Blank) pass every check: T1 fonts with `glyphtounicode`, f-ligatures
off, no hyphenation, unbreakable contact items, and entries that read left to right with inline dates.

## Shortcuts

| | |
|---|---|
| ⌘S | Save and compile |
| ⌘↵ | Recompile now (even if nothing changed) |
| ⌘J | Show the cursor's line in the PDF |
| Double-click PDF | Jump to the source |
| ⌘F | Find / replace (in the PDF when the preview has focus) |
| ⌘/ | Toggle comment |
| ⌘ + scroll | Zoom the preview |

## Development

```sh
pnpm test        # log parser, ATS checks, SyncTeX parsing, engine detection
pnpm typecheck
pnpm lint
```

Server code is in `src/server/` (compiler, log parser, ATS checks, SyncTeX, snapshots, file watcher),
the API in `src/app/api/`, the UI in `src/components/`.
