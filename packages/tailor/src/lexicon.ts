// Software-engineering terms with their common variants. Used by code, not the model: to measure
// keyword coverage (a JD's "Kubernetes" is covered by a resume's "K8s") and to catch an edit that
// introduces a technology no evidence supports.

/** canonical → aliases (case-insensitive; matched on word boundaries). */
const TERMS: Record<string, string[]> = {
  // Languages
  JavaScript: ["JS", "ECMAScript", "ES6"],
  TypeScript: ["TS"],
  Python: ["Python3"],
  Go: ["Golang"],
  Java: [],
  Kotlin: [],
  Scala: [],
  "C++": ["CPP", "C plus plus"],
  C: [],
  "C#": ["CSharp", ".NET C#"],
  Rust: [],
  Ruby: [],
  PHP: [],
  Swift: [],
  "Objective-C": ["ObjC"],
  Elixir: [],
  Erlang: [],
  Haskell: [],
  Clojure: [],
  Dart: [],
  R: [],
  Julia: [],
  Lua: [],
  Perl: [],
  Bash: ["Shell scripting", "shell"],
  SQL: [],
  GraphQL: [],
  Solidity: [],
  // Frontend
  React: ["React.js", "ReactJS"],
  "Next.js": ["NextJS", "Next"],
  Vue: ["Vue.js", "VueJS"],
  Nuxt: ["Nuxt.js"],
  Angular: ["AngularJS"],
  Svelte: ["SvelteKit"],
  Redux: [],
  "Tailwind CSS": ["Tailwind", "TailwindCSS"],
  HTML: ["HTML5"],
  CSS: ["CSS3"],
  Sass: ["SCSS"],
  Webpack: [],
  Vite: [],
  "React Native": [],
  Flutter: [],
  SwiftUI: [],
  "Jetpack Compose": [],
  Electron: [],
  "Three.js": [],
  WebGL: [],
  WebRTC: [],
  WebAssembly: ["Wasm"],
  // Backend frameworks
  "Node.js": ["Node", "NodeJS"],
  "Express.js": ["Express", "ExpressJS"],
  NestJS: ["Nest.js"],
  Fastify: [],
  Deno: [],
  Bun: [],
  Django: [],
  Flask: [],
  FastAPI: [],
  "Spring Boot": ["Spring"],
  "Ruby on Rails": ["Rails", "RoR"],
  Laravel: [],
  ".NET": ["dotnet", "ASP.NET", ".NET Core"],
  gRPC: [],
  "Protocol Buffers": ["Protobuf", "protobufs"],
  "REST APIs": ["REST", "RESTful", "REST API"],
  WebSockets: ["WebSocket"],
  tRPC: [],
  OpenAPI: ["Swagger"],
  // Data
  PostgreSQL: ["Postgres", "PSQL"],
  MySQL: [],
  SQLite: [],
  MongoDB: ["Mongo"],
  Redis: [],
  Cassandra: [],
  DynamoDB: [],
  Elasticsearch: ["Elastic", "ELK"],
  OpenSearch: [],
  ClickHouse: [],
  Snowflake: [],
  BigQuery: [],
  Redshift: [],
  "Apache Kafka": ["Kafka"],
  RabbitMQ: [],
  "Apache Pulsar": ["Pulsar"],
  NATS: [],
  "Amazon SQS": ["SQS"],
  "Amazon SNS": ["SNS"],
  "Google Pub/Sub": ["Pub/Sub", "PubSub"],
  "Apache Spark": ["Spark", "PySpark"],
  "Apache Flink": ["Flink"],
  "Apache Airflow": ["Airflow"],
  dbt: [],
  Hadoop: [],
  Presto: ["Trino"],
  "Delta Lake": [],
  Supabase: [],
  Firebase: ["Firestore"],
  Prisma: [],
  pgvector: [],
  Pinecone: [],
  Neo4j: [],
  // Cloud & infra
  AWS: ["Amazon Web Services"],
  GCP: ["Google Cloud", "Google Cloud Platform"],
  Azure: ["Microsoft Azure"],
  "AWS Lambda": ["Lambda"],
  "Amazon EC2": ["EC2"],
  "Amazon S3": ["S3"],
  "Amazon ECS": ["ECS"],
  "Amazon EKS": ["EKS"],
  "Amazon RDS": ["RDS"],
  "AWS CloudFormation": ["CloudFormation"],
  "AWS CDK": ["CDK"],
  "Google Kubernetes Engine": ["GKE"],
  "Azure Kubernetes Service": ["AKS"],
  "Cloud Functions": ["GCP Cloud Functions", "Google Cloud Functions"],
  "Cloud Run": [],
  Serverless: ["Serverless Framework", "serverless"],
  Kubernetes: ["K8s", "k8s"],
  Docker: ["containers", "containerization"],
  Helm: [],
  Terraform: ["HCL"],
  Pulumi: [],
  Ansible: [],
  "CI/CD": ["CI", "continuous integration", "continuous delivery", "continuous deployment"],
  "GitHub Actions": [],
  GitLab: ["GitLab CI"],
  Jenkins: [],
  CircleCI: [],
  ArgoCD: ["Argo CD"],
  Nginx: [],
  Envoy: [],
  Istio: [],
  Linux: ["Unix"],
  Vercel: [],
  Netlify: [],
  Cloudflare: ["Cloudflare Workers"],
  Temporal: [],
  BullMQ: ["Bull"],
  Celery: [],
  Modal: [],
  // Observability
  Prometheus: [],
  Grafana: [],
  Datadog: [],
  "New Relic": [],
  Sentry: [],
  OpenTelemetry: ["OTel"],
  Jaeger: [],
  Splunk: [],
  // ML / AI
  "Machine Learning": ["ML"],
  "Deep Learning": [],
  PyTorch: [],
  TensorFlow: [],
  "scikit-learn": ["sklearn"],
  Pandas: [],
  NumPy: [],
  "Hugging Face": ["HuggingFace", "Transformers"],
  LLMs: ["LLM", "large language models"],
  RAG: ["retrieval-augmented generation"],
  "Vector search": ["vector database", "embeddings"],
  LangChain: [],
  "OpenAI API": [],
  "Vercel AI SDK": ["AI SDK"],
  OpenCV: [],
  FFmpeg: [],
  CUDA: [],
  MLOps: [],
  // Practices
  "Distributed systems": ["distributed computing"],
  Microservices: ["microservice", "service-oriented architecture", "SOA"],
  "Event-driven architecture": ["event-driven", "event sourcing"],
  "System design": [],
  Concurrency: ["multithreading", "parallelism"],
  Scalability: ["scalable", "horizontal scaling"],
  "High availability": ["HA", "fault tolerance", "fault-tolerant"],
  Caching: [],
  "Data modeling": [],
  "API design": [],
  "Test-driven development": ["TDD"],
  "Unit testing": ["unit tests"],
  "Integration testing": ["integration tests"],
  "End-to-end testing": ["E2E", "e2e tests"],
  Jest: [],
  Vitest: [],
  Playwright: [],
  Cypress: [],
  Pytest: [],
  Agile: ["Scrum", "Kanban"],
  "Code review": ["code reviews"],
  Mentoring: ["mentored", "mentorship"],
  "On-call": ["incident response", "SRE"],
  Observability: ["monitoring", "tracing", "logging"],
  Security: ["OWASP", "AppSec"],
  OAuth: ["OAuth2", "OIDC", "OpenID Connect"],
  Git: [],
  Performance: ["performance optimization", "latency"],
  Accessibility: ["a11y", "WCAG"],
  Payments: ["payment processing"],
  Fintech: ["financial technology"],
  "Data structures": ["algorithms"],
};

/**
 * Practices and concepts (not products): they count for coverage, but an edit may phrase work in these
 * terms without a citation for the exact word ("latency", "scalable", "mentored").
 */
const SOFT = new Set([
  "Distributed systems", "Microservices", "Event-driven architecture", "System design", "Concurrency", "Scalability",
  "High availability", "Caching", "Data modeling", "API design", "Test-driven development", "Unit testing",
  "Integration testing", "End-to-end testing", "Agile", "Code review", "Mentoring", "On-call", "Observability",
  "Security", "Performance", "Accessibility", "Payments", "Fintech", "Data structures", "Machine Learning",
  "Deep Learning", "LLMs", "RAG", "Vector search", "MLOps", "REST APIs", "Serverless", "Docker", "CI/CD", "Linux", "Bash",
]);

export function isSoftTerm(term: string): boolean {
  return SOFT.has(canonical(term));
}

export interface LexiconEntry {
  term: string;
  aliases: string[];
}

export const LEXICON: LexiconEntry[] = Object.entries(TERMS).map(([term, aliases]) => ({ term, aliases }));

/**
 * Using a managed service is evidence for its platform: running workers on AKS is Azure experience,
 * pgvector is PostgreSQL. Only certain implications belong here (a product of exactly one platform).
 */
const IMPLIES: Record<string, string[]> = {
  AWS: ["AWS Lambda", "Amazon EC2", "Amazon S3", "Amazon ECS", "Amazon EKS", "Amazon RDS", "AWS CloudFormation", "AWS CDK", "DynamoDB", "Amazon SQS", "Amazon SNS"],
  GCP: ["Google Kubernetes Engine", "Cloud Functions", "Cloud Run", "BigQuery"],
  Azure: ["Azure Kubernetes Service"],
  Kubernetes: ["Amazon EKS", "Google Kubernetes Engine", "Azure Kubernetes Service"],
  PostgreSQL: ["pgvector", "Supabase"],
};

/** Terms whose mention also proves `term` (its managed services, its extensions). */
export function impliedBy(term: string): string[] {
  return IMPLIES[canonical(term)] ?? [];
}

/** Single-letter / ambiguous terms only count when written exactly (case-sensitive): "C", "R", "Go". */
const CASE_SENSITIVE = new Set(["C", "R", "Go", "Next", "Node", "Spark", "Modal", "Bun", "Elastic", "Rails", "CI", "HA", "ML", "TS", "JS", "Lambda", "Spring", "Bull", "shell", "containers", "Unix", "LLM", "HCL"]);

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex matching a term as a whole word (allowing punctuation inside terms like C++, Node.js, CI/CD). */
export function termRegex(term: string): RegExp {
  const flags = CASE_SENSITIVE.has(term) ? "g" : "gi";
  return new RegExp(`(?<![A-Za-z0-9+#.])${escapeRe(term)}(?![A-Za-z0-9+#]|\\.[A-Za-z])`, flags);
}

export function containsTerm(text: string, term: string): boolean {
  return termRegex(term).test(text);
}

/** All the ways a canonical term can be written: itself, its lexicon aliases, and extra aliases. */
export function variants(term: string, extra: string[] = []): string[] {
  const entry = LEXICON.find((e) => e.term.toLowerCase() === term.toLowerCase() || e.aliases.some((a) => a.toLowerCase() === term.toLowerCase()));
  return [...new Set([term, ...(entry ? [entry.term, ...entry.aliases] : []), ...extra])];
}

/** True if the text mentions the term in any of its forms. */
export function mentions(text: string, term: string, extra: string[] = []): boolean {
  return variants(term, extra).some((v) => containsTerm(text, v));
}

/**
 * Technology terms in a text, as canonical names (only lexicon terms and the given extra terms). Short,
 * ambiguous aliases ("CI", "ML") count only when written exactly.
 */
export function techTerms(text: string, extra: { term: string; aliases: string[] }[] = [], opts: { hardOnly?: boolean } = {}): string[] {
  const found = new Set<string>();
  for (const e of [...LEXICON, ...extra]) {
    if (opts.hardOnly && isSoftTerm(e.term)) continue;
    if ([e.term, ...e.aliases].some((v) => v.length > 1 && containsTerm(text, v))) found.add(canonical(e.term));
  }
  return [...found];
}

/** The lexicon's canonical spelling of a term (or the term itself). */
export function canonical(term: string): string {
  const t = term.toLowerCase();
  return LEXICON.find((e) => e.term.toLowerCase() === t || e.aliases.some((a) => a.toLowerCase() === t))?.term ?? term;
}
