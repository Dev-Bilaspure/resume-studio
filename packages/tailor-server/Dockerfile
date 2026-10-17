# The tailoring service with TeX Live and poppler, so drafts are compiled and checked like on Overleaf.
# Build from the repository root:
#   docker build -f packages/tailor-server/Dockerfile -t resume-tailor-server .
#   docker run -p 8787:8787 -e TAILOR_API_KEY=… -e ANTHROPIC_API_KEY=… -v tailor-data:/data resume-tailor-server
FROM node:24-bookworm-slim

# TeX Live (pdfLaTeX, XeLaTeX, LuaLaTeX, the packages resume templates use) and pdfinfo/pdftotext.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      latexmk texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra \
      texlive-xetex texlive-luatex texlive-bibtex-extra biber poppler-utils fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app
# Only what the service needs: the workspace files and its packages (the editor app is left out).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/llm packages/llm
COPY packages/tailor packages/tailor
COPY packages/tailor-latex packages/tailor-latex
COPY packages/tailor-server packages/tailor-server
RUN pnpm install --frozen-lockfile --prod --filter @resume-studio/tailor-server...

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 TAILOR_DATA_DIR=/data
# Owned by the user the service runs as, so a new volume starts out writable.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
# Node runs the TypeScript sources directly (type stripping); workspace packages resolve to their folders.
CMD ["node", "packages/tailor-server/src/main.ts"]
