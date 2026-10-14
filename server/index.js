import express from "express";
import helmet from "helmet";
import Database from "better-sqlite3";
import sharp from "sharp";
import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
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

const env = {
  ...process.env,
  S3_ENDPOINT: process.env.AWS_ENDPOINT_URL_S3,
  S3_BUCKET: process.env.BUCKET_NAME,
  S3_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  S3_REGION: process.env.AWS_REGION || "auto",
};

for (const key of required) {
  if (!env[key]) {
    throw Error(`Missing ${key}`);
  }
}
if (env.ADMIN_PASSWORD.length < 24)
  throw Error("ADMIN_PASSWORD must be >= 24 characters");
const dataDir = env.DATA_DIR || "./data";
mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "photos.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(readFileSync(path.join(root, "schema.sql"), "utf8"));
const s3 = new S3Client({
  region: env.S3_REGION || "auto",
  endpoint: env.S3_ENDPOINT,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});
const bucket = env.S3_BUCKET;
const app = express();
app.use((req, res, next) => {
  const started = Date.now();

  console.log(`[REQUEST] ${req.method} ${req.path}`);

  res.on("finish", () => {
    console.log(
      `[RESPONSE] ${req.method} ${req.path} ` +
        `${res.statusCode} (${Date.now() - started}ms)`,
    );
  });

  res.on("close", () => {
    if (!res.writableFinished) {
      console.warn(
        `[DISCONNECTED] ${req.method} ${req.path} ` +
          `after ${Date.now() - started}ms`,
      );
    }
  });

  next();
});
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();
const clean = (x, max) => (typeof x === "string" ? x.trim().slice(0, max) : "");
const error = (res, message, status = 400) =>
  res.status(status).json({ error: message });
const admin = (req, res, next) => {
  const token = (req.get("authorization") || "").replace(/^Bearer /, "");
  const a = Buffer.from(sha(token), "hex"),
    b = Buffer.from(sha(env.ADMIN_PASSWORD), "hex");
  if (!timingSafeEqual(a, b)) return error(res, "Unauthorized", 401);
  next();
};
const allowedHostnames = new Set([
  "barnasfristed.no",
  "www.barnasfristed.no",
  "barnas-fristed.myshopify.com",
]);

const previewHostnamePattern = /^[a-z0-9-]+\.shopifypreview\.com$/;

const isAllowedHostname = (hostname) =>
  allowedHostnames.has(hostname) || previewHostnamePattern.test(hostname || "");

const isAllowedOrigin = (origin) => {
  try {
    const url = new URL(origin);

    return (
      url.protocol === "https:" &&
      isAllowedHostname(url.hostname) &&
      !url.port &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};
const cors = (req, res, next) => {
  const origin = req.get("origin");

  res.vary("Origin");

  if (isAllowedOrigin(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }

  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
    return res.sendStatus(204);
  }

  next();
};

const allowOrigin = (req, res, next) =>
  isAllowedOrigin(req.get("origin"))
    ? next()
    : error(res, "Invalid origin", 403);

app.use(cors);
app.use(express.json({ limit: "12kb" }));

async function turnstile(token, ip) {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
    remoteip: ip,
  });

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body,
    },
  );

  if (!response.ok) return false;

  const result = await response.json();

  return result.success === true && isAllowedHostname(result.hostname);
}
async function put(key, body) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "image/webp",
    }),
  );
}
async function get(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}
async function del(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (_req, res) =>
  res.json({
    siteKey: env.TURNSTILE_SITE_KEY,
    consentVersion: env.CONSENT_VERSION || "2026-10-v1",
  }),
);
app.get("/api/gallery", (req, res) => {
  const page = Math.max(
    0,
    Math.min(100, Number.parseInt(req.query.page, 10) || 0),
  );
  const photos = db
    .prepare(
      "SELECT id,display_name,description,product_handle,approved_at FROM photos WHERE status='approved' ORDER BY approved_at DESC LIMIT 24 OFFSET ?",
    )
    .all(page * 24);
  res.json({
    photos: photos.map((p) => ({
      ...p,
      imageUrl: `${env.PUBLIC_ORIGIN}/images/${p.id}`,
    })),
    nextPage: photos.length === 24 ? page + 1 : null,
  });
});
app.get("/images/:id", async (req, res) => {
  try {
    const row = db
      .prepare("SELECT object_key FROM photos WHERE id=? AND status='approved'")
      .get(req.params.id);
    if (!row) return error(res, "Not found", 404);
    res
      .set({
        "Content-Type": "image/webp",
        "Cache-Control": "public,max-age=60",
        "X-Content-Type-Options": "nosniff",
      })
      .send(await get(row.object_key));
  } catch (e) {
    console.error(e);
    error(res, "Image unavailable", 500);
  }
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 12 },
});
const CONSENT_TEXT =
  "Jeg bekrefter at jeg har rett til å dele bildet, " +
  "at jeg har innhentet nødvendige tillatelser fra " +
  "eventuelle avbildede personer, og gir Barnas Fristed " +
  "tillatelse til publisering i inspirasjonsgalleriet. " +
  "Separat frivillig samtykke gjelder markedsføring.";
app.post(
  "/api/submit",
  allowOrigin,
  upload.single("image"),
  async (req, res) => {
    try {
      const ip = sha(req.ip || "unknown"),
        epoch = Math.floor(Date.now() / 1000);
      const row = db
        .prepare("SELECT count,expires_at FROM request_limits WHERE key=?")
        .get(ip);
      if (row && row.expires_at > epoch && row.count >= 5)
        return error(res, "Too many submissions", 429);
      db.prepare(
        "INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<? THEN ? ELSE expires_at END",
      ).run(ip, epoch + 3600, epoch, epoch, epoch + 3600);
      if (!(await turnstile(clean(req.body.turnstileToken, 4096), req.ip)))
        return error(res, "Verification failed", 403);
      if (req.body.galleryConsent !== "true")
        return error(res, "Gallery permission required");
      if (!req.file) return error(res, "Image required");
      // Decode and re-encode on server to strip metadata and reject malformed input.
      const img = sharp(req.file.buffer, {
        limitInputPixels: 25_000_000,
        failOn: "error",
      });
      const meta = await img.metadata();
      if (!["jpeg", "png", "webp", "heif", "avif"].includes(meta.format))
        return error(res, "Unsupported image format");
      const bytes = await img
        .rotate()
        .resize({
          width: 2200,
          height: 2200,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer();
      const id = randomUUID(),
        token = randomUUID() + randomUUID(),
        key = `photos/${id}.webp`;
      const product = clean(req.body.productHandle, 120);
      if (product && !/^[a-z0-9-]+$/.test(product))
        return error(res, "Invalid product");
      const marketing = req.body.marketingConsent === "true" ? 1 : 0,
        version = env.CONSENT_VERSION || "2026-10-v1",
        timestamp = now();
      await put(key, bytes);
      try {
        db.transaction(() => {
          db.prepare(
            "INSERT INTO photos(id,object_key,display_name,description,product_handle,status,gallery_consent,marketing_consent,consent_version,consent_text,submitted_at,removal_token_hash) VALUES(?,?,?,?,?,'pending',1,?,?,?,?,?)",
          ).run(
            id,
            key,
            clean(req.body.displayName, 80),
            clean(req.body.description, 500),
            product || null,
            marketing,
            version,
            CONSENT_TEXT,
            timestamp,
            sha(token),
          );
          db.prepare(
            "INSERT INTO consent_events(id,photo_id,action,version,consent_text,marketing_consent,created_at) VALUES(?,?,?,?,?,?,?)",
          ).run(
            randomUUID(),
            id,
            "submitted",
            version,
            CONSENT_TEXT,
            marketing,
            timestamp,
          );
        })();
      } catch (e) {
        await del(key);
        throw e;
      }
      res
        .status(201)
        .json({
          ok: true,
          id,
          removalToken: token,
          message: "Bildet er sendt til godkjenning.",
        });
    } catch (e) {
      console.error(e);
      error(res, "Invalid image or upload failed", 400);
    }
  },
);
app.get("/remove.html", (_req, res) =>
  res.type("html").send(readFileSync(path.join(root, "remove.html"), "utf8")),
);
app.post("/api/remove", allowOrigin, async (req, res) => {
  const { id, token } = req.body || {};
  const row = db
    .prepare("SELECT object_key,removal_token_hash FROM photos WHERE id=?")
    .get(id);
  if (!row || !token || sha(token) !== row.removal_token_hash)
    return error(res, "Invalid removal link", 403);
  db.prepare("UPDATE photos SET status='deleted',deleted_at=? WHERE id=?").run(
    now(),
    id,
  );
  await del(row.object_key);
  db.prepare(
    "INSERT INTO consent_events(id,photo_id,action,version,consent_text,marketing_consent,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    id,
    "withdrawn",
    env.CONSENT_VERSION || "2026-10-v1",
    "Withdrawal",
    0,
    now(),
  );
  res.json({ ok: true });
});
app.get("/admin", (_req, res) =>
  res.type("html").send(readFileSync(path.join(root, "admin.html"), "utf8")),
);
app.get("/api/admin/photos", admin, (req, res) => {
  const status = ["pending", "approved", "rejected"].includes(req.query.status)
    ? req.query.status
    : "pending";
  res.json({
    photos: db
      .prepare(
        "SELECT id,display_name,description,product_handle,status,marketing_consent,submitted_at FROM photos WHERE status=? ORDER BY submitted_at DESC LIMIT 100",
      )
      .all(status),
  });
});
app.get("/api/admin/preview/:id", admin, async (req, res) => {
  try {
    const row = db
      .prepare("SELECT object_key FROM photos WHERE id=?")
      .get(req.params.id);
    if (!row) return error(res, "Not found", 404);
    res.set("Content-Type", "image/webp").send(await get(row.object_key));
  } catch (e) {
    console.error(e);
    error(res, "Unavailable", 500);
  }
});
app.post("/api/admin/photos/:id/:action", admin, async (req, res) => {
  const { id, action } = req.params;
  if (!["approve", "reject", "delete"].includes(action))
    return error(res, "Invalid action");
  const row = db.prepare("SELECT object_key FROM photos WHERE id=?").get(id);
  if (!row) return error(res, "Not found", 404);
  const status = { approve: "approved", reject: "rejected", delete: "deleted" }[
    action
  ];
  db.prepare(
    "UPDATE photos SET status=?,approved_at=CASE WHEN ?='approved' THEN ? ELSE approved_at END,deleted_at=CASE WHEN ?='deleted' THEN ? ELSE deleted_at END WHERE id=?",
  ).run(status, status, now(), status, now(), id);
  if (action === "delete") await del(row.object_key);
  res.json({ ok: true, status });
});
app.listen(Number(env.PORT || 8080), "0.0.0.0", () => console.log("Listening"));
