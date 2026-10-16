// Manual check: node --experimental-strip-types scripts/smoke.ts <provider> <model>
import { z } from "zod";
import { createLLM, testConnection, type ProviderId } from "../src/index.ts";

const [provider = "claude-code", model = "opus"] = process.argv.slice(2);
const config = { provider: provider as ProviderId, model, apiKey: process.env.LLM_API_KEY };
console.log("connection:", await testConnection(config));
const llm = createLLM(config);
const res = await llm.generate({
  system: "You extract structured data from job descriptions.",
  prompt: "Job: Senior Backend Engineer at Acme. Must have Go, Kafka and Kubernetes; Terraform is a plus. 5+ years.",
  schema: z.object({
    role: z.string(),
    mustHave: z.array(z.string()),
    niceToHave: z.array(z.string()),
    minYears: z.number().nullable(),
  }),
  schemaName: "job_requirements",
});
console.log(JSON.stringify(res, null, 2));
