# Resume Studio

A local LaTeX resume editor: code on the left, the real PDF on the right, rebuilt on every save, with a
built-in ATS (applicant tracking system) check of what a parser actually extracts from your PDF.
Everything runs on your computer; your resumes are plain `.tex` files you own.

## Setup

You need Node 24 and pnpm, and TeX: either the compile service in Docker (nothing else to install, same
on macOS, Linux and Windows) or TeX Live on this machine.

```sh
docker compose up -d                # the compile service: TeX Live 2026, latexmk, poppler (first run downloads a few GB)
pnpm install
pnpm dev                            # http://127.0.0.1:4317
```

Then pick a model under **AI providers** (home page, ⚙) for tailoring: your Claude Code login, or an API
key for Anthropic, OpenAI or Vertex AI.

Without Docker, install TeX on this machine instead; the app uses it when it's there:

```sh
brew install --cask mactex-no-gui   # macOS: full TeX Live (same as Overleaf); needs your password
brew install poppler                # pdftotext/pdffonts/pdfinfo for the ATS check
```

(Linux: TeX Live's installer or `texlive-full`, and `poppler-utils`.) `RESUME_STUDIO_COMPILER=local` or
`service` in `apps/web/.env.local` pins the choice; see [the compile service](packages/tex-service/README.md).
On Windows, run the app in WSL 2.

Production mode: `pnpm build && pnpm start`. The server only answers on 127.0.0.1.

## Repo layout

A pnpm workspace; [Turborepo](https://turborepo.com) runs `build`, `typecheck`, `test` and `lint` across
it in dependency order (`pnpm typecheck`, `pnpm test` from the root).

```
apps/web/                 the editor (Next.js): app, compiler, templates
packages/tex-service/     the compile service: TeX Live in a container, its HTTP API and client
packages/llm/             one interface over Claude Code, OpenAI, Anthropic and Vertex AI
packages/tailor/          the job-tailoring engine (format-neutral)
packages/tailor-latex/    the engine's LaTeX adapter
packages/tailor-cli/      `resume-tailor`: tailoring from the command line
packages/tailor-server/   the engine as an HTTP service (Docker image included)
packages/tailor-mcp/      the engine as an MCP server, for Claude Desktop and other assistants
packages/tailor-eval/     measures tailoring quality: blind recruiter screens and a truthfulness audit
```

Packages depend one way only (tex-service, llm ← tailor ← tailor-latex ← cli/server/mcp/eval/web): a cycle makes
pnpm link the packages into each other endlessly, and the bundler walks that loop until it runs out of
memory. In the repo they run from TypeScript source; `pnpm build` also compiles them to `dist/`, which is
what a packed or published copy uses.

## Where things live

```
resumes/<name>/          your resumes: main.tex (+ any \input files, .cls, images) and resume.json
.resume-studio/          app state, safe to delete except git/ (your snapshot history)
  build/<name>/          latexmk aux files (incremental builds)
  publish/<name>/        the PDFs the preview shows (last few builds)
  git/                   snapshot history (a git repo the app owns; it never touches this repo)
  sync/                  Backup & sync: its own git repo, the connection, and backups of replaced files
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
with TeX on this Mac, documents that ask for such fonts are built with LuaLaTeX, which finds them, unless
they load XeTeX-only packages. The build's info note and the status bar say when this happened. The
compile service is Linux, set up like Overleaf: its XeLaTeX finds them.

**Like Overleaf's compile servers**, TeX runs in the main file's folder (`latexmk -cd`) and carries on past
errors (`latexmk -f`) unless "Stop on first error" is on. BibTeX/biber problems from the `.blg` (bad
entries with their `.bib` line, missing keys) are listed in Problems. Imported archives keep symlinks that
point inside the project as copies (e.g. Awesome-CV's `examples/awesome-cv.cls`).

Tested with Jake's Resume, Awesome-CV, Deedy, moderncv and AltaCV as they ship on GitHub: all build
without errors.

**Trusted projects.** Overleaf runs every project with shell escape inside a sandbox. Here, a `.tex`
file runs on your computer (or in the compile service's container), so by default TeX gets its *restricted* shell escape (only vetted helpers such as
`epstopdf`) and a project's `latexmkrc` is ignored. Settings → Compiler → **Trusted project** enables
`-shell-escape` (minted, svg, gnuplot) and the project `latexmkrc` for projects you trust.

## How it works

- **Compile**: `latexmk` with pdfLaTeX, XeLaTeX, LuaLaTeX or LaTeX → DVI → PDF (per resume, or
  `% !TEX program = xelatex` in the main file), on this machine or in the compile service (the same
  command line either way; the service gets only the files that changed). Like Overleaf's compile
  servers, a build runs in a mirror of the project (`.resume-studio/build/`, or the service's volume), so every helper sees relative paths, TeX's write
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

## Tailoring for a job

**Tailor** (on a resume's card on the home page, or in the editor's top bar) takes a job posting and makes a tailored copy of
a resume. The engine reads the posting (requirements, must-have keywords, level, hard filters), matches
each requirement to your bullets and saved facts, asks about must-haves your resume doesn't show, then
rewrites the relevant parts in the job's language. You review every change as a diff with its reason and
evidence, watch the PDF update as you accept or reject, and save the result as a new resume (the
original is never changed; the posting is kept with it as `jd.md`).

It never invents experience. Every new claim has to trace back to your resume or to an answer you gave:
new numbers are refused outright, a technology may only appear where its evidence names it, a second
model fact-checks every change, and the draft is compiled to prove it builds and fits the page. Answers
you give become facts (`resumes/_profile/facts.json`) that later applications can use; a "haven't done
this" is kept too, so it isn't asked again and nothing implies it. Suggestions the checks leave out are
listed in the review with the reason. Your on/off choices are kept until you save.

The model is your choice under **AI providers**: your Claude Code login (no key needed), the Anthropic
API, OpenAI or Google Vertex AI. Keys are kept in the macOS Keychain (on Linux and Windows, in
`.resume-studio/secrets.json`, readable only by your user).

The same engine also runs outside the app:

```sh
pnpm tailor resumes/my-cv --jd posting.txt --company Acme --role "Backend Engineer" --out resumes/my-cv-acme
TAILOR_ENABLE_CLAUDE_CODE=1 node packages/tailor-server/src/main.ts     # HTTP API, see its README
node packages/tailor-mcp/bin/resume-tailor-mcp.js                       # MCP server, see its README
```

**Measuring it.** `pnpm eval run --model opus --judge-model opus` tailors each resume in
`eval-data/resumes/` for each job posting in `eval-data/jds/` (pairs in `eval-data/cases.json`), then has
an independent judge (a) audit the tailored text against the original for anything unsupported and
(b) screen the original and the tailored resume each on its own, as a recruiter. The report
(`eval-results/<run>/report.md`) shows how often the tailored resume is the one advanced, the fit change,
and every truthfulness issue. Runs resume where they stopped (e.g. after a usage limit). The data and
results stay on your machine.

## Backup & sync

**Sync** (home page) keeps your data in a private git repository you own, so losing this folder, or moving
to another computer, loses nothing:

1. Create an empty **private** repository (GitHub or any git host), only for this.
2. Paste its address on the Sync page. Your git login on this computer is used: if `git push` to it works
   in a terminal, it works here. A public GitHub repository is refused.
3. **Upload** sends what changed here; **Download** brings what changed there. The page lists both, file by
   file, with the changes, before you click.

Restoring: clone this project, `pnpm install && pnpm dev`, open Sync, connect the same repository,
Download. PDFs rebuild by themselves; enter your API keys again (they're never uploaded).

Synced: everything that can't be rebuilt. `resumes/` (resumes, tailored copies, `jd.md`, your facts),
tailoring sessions, snapshot history with its labels, deleted resumes in the trash, your AI provider
choices and your preferences (editor settings, preview zoom, pane sizes: kept by the browser and mirrored to
`.resume-studio/preferences.json`). Never synced: API keys, and PDFs and build files (rebuilt).

Snapshot history is the `snapshots` branch of the repository, labels its `snap/…` tags, next to the data on
`main`; an upload sends all three in one push, so the repository is never left half-updated. When two
computers both took snapshots, a download joins the two histories and keeps every snapshot. A label
changed on both sides keeps this computer's placement.

A file changed both here and in the repository is shown side by side: you choose which to keep, and a
version from this computer that's replaced is saved in `.resume-studio/sync/backups/` first. Uploads refuse
anything that looks like an API key or token, downloads refuse a repository containing anything but this
data, and a download interrupted half-way is finished the next time you sync.

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
pnpm test        # log parser, ATS checks, SyncTeX, engine detection, the compile service, the engine
pnpm typecheck
pnpm lint
```

Server code is in `apps/web/src/server/` (compiler, log parser, ATS checks, SyncTeX, snapshots, file watcher),
the API in `apps/web/src/app/api/`, the UI in `apps/web/src/components/`.
