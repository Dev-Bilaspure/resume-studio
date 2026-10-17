# The tailoring service on the official, complete TeX Live (the same distribution as Overleaf and
# MacTeX), so a resume that builds there builds here. Build from the repository root:
#   docker build -f packages/tailor-server/Dockerfile -t resume-tailor-server .
#   docker run -p 8787:8787 -e TAILOR_API_KEY=… -e ANTHROPIC_API_KEY=… -v tailor-data:/data resume-tailor-server

# 1. The service's Node dependencies (the editor app is left out).
FROM node:24-bookworm-slim AS app
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/llm packages/llm
COPY packages/tailor packages/tailor
COPY packages/tailor-latex packages/tailor-latex
COPY packages/tailor-server packages/tailor-server
RUN pnpm install --frozen-lockfile --prod --filter @resume-studio/tailor-server...

# 2. TeX Live 2026, full scheme. Pinned by digest: update it deliberately, then rebuild and test.
FROM texlive/texlive:latest-full@sha256:0f4884ca7d287f47ab466d2dd405d4c901c576585363f628863a7ca7eea21301
# pdfinfo/pdftotext for page counts and text, and the free stand-ins for Arial, Times New Roman and
# Courier New (Carlito and Caladea, for Calibri and Cambria, come with TeX Live).
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils fontconfig fonts-liberation2 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f
COPY --from=app /usr/local/bin/node /usr/local/bin/node
COPY --from=app /app /app

RUN useradd --create-home --uid 10001 tailor && mkdir -p /data && chown tailor:tailor /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 TAILOR_DATA_DIR=/data
VOLUME /data
EXPOSE 8787
USER tailor
WORKDIR /app
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Node runs the TypeScript sources directly (type stripping); workspace packages resolve to their folders.
CMD ["node", "packages/tailor-server/src/main.ts"]
