// Starts the tailoring service from environment variables (see README.md).
import { configFromEnv } from "./config.ts";
import { createTailorServer } from "./server.ts";

const config = configFromEnv();
const server = createTailorServer(config);
server.listen(config.port, config.host, () => {
  console.log(`tailor-server on http://${config.host}:${config.port} · providers: ${config.providers.map((p) => p.provider).join(", ")}${config.apiKey ? " · auth on" : ""}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Runs in flight are resumable (POST …/retry) after a restart.
    server.close();
    process.exit(0);
  });
}
