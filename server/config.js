// Environment, required settings and data directory. Read once at import time.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// server/ directory (schema.sql and the HTML pages live here).
export const root = path.dirname(fileURLToPath(import.meta.url));

const required = [
  "PUBLIC_ORIGIN",
  "SHOP_ORIGIN",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET",
  "ADMIN_PASSWORD",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
];

export const env = {
  ...process.env,
  S3_ENDPOINT: process.env.AWS_ENDPOINT_URL_S3,
  S3_BUCKET: process.env.BUCKET_NAME,
  S3_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  S3_REGION: process.env.AWS_REGION || "auto",
};

for (const key of required) {
  if (!env[key]) throw Error(`Missing ${key}`);
}
if (env.ADMIN_PASSWORD.length < 24) throw Error("ADMIN_PASSWORD must be >= 24 characters");

export const dataDir = env.DATA_DIR || "./data";
mkdirSync(dataDir, { recursive: true });

// Positive number from an env string, else the default.
export const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
