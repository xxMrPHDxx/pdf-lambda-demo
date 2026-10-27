import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Support both repo-root development and running from apps/api.
for (const candidate of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate, override: false });
  }
}

function str(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function num(key: string, fallback: number): number {
  const parsed = Number(str(key, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const value = str(key, String(fallback)).toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function optionalStr(key: string, fallback = ""): string {
  const value = process.env[key];
  if (value === undefined) {
    return fallback;
  }
  return value.trim();
}

export const env = {
  port: num("PORT", 3000),
  corsOrigins: str("CORS_ORIGINS", "http://localhost:5173,http://localhost:8080")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  region: str("AWS_REGION", "us-east-1"),
  // Empty means real AWS. LocalStack deployments must set these explicitly.
  endpoint: optionalStr("AWS_ENDPOINT_URL"),
  publicEndpoint: optionalStr("S3_PUBLIC_ENDPOINT"),
  bucket: str("S3_BUCKET", "pdf-demo"),
  table: str("DDB_TABLE", "pdf-demo"),
  batchQueueUrl: str("SQS_BATCH_QUEUE", "http://localhost:4566/000000000000/pdf-demo-batches"),
  finalizeQueueUrl: str("SQS_FINALIZE_QUEUE", "http://localhost:4566/000000000000/pdf-demo-finalize"),
  redisUrl: str("REDIS_URL", "redis://localhost:6379"),
  autoProvision: bool("AUTO_PROVISION", true),
  batchSize: Math.max(1, num("BATCH_SIZE", 4)),
  maxRunningJobs: Math.max(1, num("MAX_RUNNING_JOBS", 10)),
  maxClientRunningJobs: Math.max(1, num("MAX_CLIENT_RUNNING_JOBS", 2)),
  pdfCacheDays: Math.max(1, num("PDF_CACHE_DAYS", 7)),
  zipCacheHours: Math.max(1, num("ZIP_CACHE_HOURS", 3)),
  sesFrom: str("SES_FROM", "orders@pdfdemo.local"),
  sesSaveToS3: bool("SES_SAVE_TO_S3", true),
  presignExpiresSeconds: Math.max(60, num("PRESIGN_EXPIRES_SECONDS", 604800)),
} as const;

export const QUEUE_NAMES = {
  batches: "pdf-demo-batches",
  batchesDlq: "pdf-demo-batches-dlq",
  finalize: "pdf-demo-finalize",
  finalizeDlq: "pdf-demo-finalize-dlq",
} as const;

export const TERMINAL_JOB_STATUSES = new Set(["COMPLETED", "FAILED"]);
