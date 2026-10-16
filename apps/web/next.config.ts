import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev-tools badge would sit on top of the file sidebar.
  devIndicators: false,
  // The workspace packages ship TypeScript source.
  transpilePackages: ["@resume-studio/llm", "@resume-studio/tailor", "@resume-studio/tailor-latex"],
  // These locate native binaries / credentials at runtime: keep them out of the bundle.
  serverExternalPackages: ["ai-sdk-provider-claude-code", "@anthropic-ai/claude-agent-sdk", "google-auth-library"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
