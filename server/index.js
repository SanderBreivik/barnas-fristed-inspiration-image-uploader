import express from "express";
import helmet from "helmet";
import Database from "better-sqlite3";
import sharp from "sharp";
import {
  backupDatabase,
  backupIfDue,
  reconcile,
  retryDeletions,
} from "./maintenance.js";
import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  readFileSync,
  mkdirSync
} from "node:fs";
import path from "node:path";
import {
  fileURLToPath
} from "node:url";
const root = path.dirname(fileURLToPath(
  import.meta.url));
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
mkdirSync(dataDir, {
  recursive: true
});
const db = new Database(path.join(dataDir, "photos.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(readFileSync(path.join(root, "schema.sql"), "utf8"));
// Additive migration: tracks whether the stored object is confirmed deleted.
// Back up photos.sqlite before first deploy (see README).
if (!db.prepare("PRAGMA table_info(photos)").all().some((c) => c.name === "storage_deleted_at"))
  db.exec("ALTER TABLE photos ADD COLUMN storage_deleted_at TEXT");
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
app.use(helmet({
  contentSecurityPolicy: false
}));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();
const clean = (x, max) => (typeof x === "string" ? x.trim().slice(0, max) : "");
const error = (res, message, status = 400) =>
  res.status(status).json({
    error: message
  });
// ---- Admin auth: password -> server-side session in an HttpOnly cookie ----
// Sessions live in memory (single Fly machine); a restart logs admins out.
const SESSION_TTL_MS = Number(env.ADMIN_SESSION_TTL_MS) || 8 * 3600_000;
const SESSION_IDLE_MS = Number(env.ADMIN_SESSION_IDLE_MS) || 30 * 60_000;
const LOGIN_MAX_FAILS = Number(env.ADMIN_LOGIN_MAX_FAILS) || 5;
const LOGIN_WINDOW_MS = Number(env.ADMIN_LOGIN_WINDOW_MS) || 15 * 60_000;
const COOKIE = "__Host-bf_admin";
const sessions = new Map(); // sid -> {csrf, created, last}
const loginFails = new Map(); // ip hash -> {count, resetAt}
const sweep = setInterval(() => {
  const t = Date.now();
  for (const [k, s] of sessions)
    if (t - s.created > SESSION_TTL_MS || t - s.last > SESSION_IDLE_MS) sessions.delete(k);
  for (const [k, f] of loginFails) if (f.resetAt < t) loginFails.delete(k);
}, 60_000);
sweep.unref();
const safeEqual = (a, b) =>
  timingSafeEqual(Buffer.from(sha(String(a)), "hex"), Buffer.from(sha(String(b)), "hex"));
const readCookie = (req, name) => {
  for (const part of (req.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
};
const sameOriginOnly = (req, res, next) =>
  req.get("origin") === env.PUBLIC_ORIGIN ? next() : error(res, "Invalid origin", 403);
const cookieOpts = (maxAge) =>
  `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const admin = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const sid = readCookie(req, COOKIE);
  const s = sessions.get(sid);
  const t = Date.now();
  if (!s || t - s.created > SESSION_TTL_MS || t - s.last > SESSION_IDLE_MS) {
    sessions.delete(sid);
    return error(res, "Unauthorized", 401);
  }
  if (req.method !== "GET" && !safeEqual(req.get("x-csrf-token") || "", s.csrf))
    return error(res, "Invalid CSRF token", 403);
  s.last = t;
  req.adminSession = sid;
  next();
};
app.post("/api/admin/login", sameOriginOnly, express.json({ limit: "2kb" }), (req, res) => {
  res.set("Cache-Control", "no-store");
  const key = sha(req.ip || "unknown"), t = Date.now();
  let f = loginFails.get(key);
  if (!f || f.resetAt < t) loginFails.set(key, (f = { count: 0, resetAt: t + LOGIN_WINDOW_MS }));
  if (f.count >= LOGIN_MAX_FAILS) {
    res.set("Retry-After", String(Math.ceil((f.resetAt - t) / 1000)));
    return error(res, "Too many attempts. Try again later.", 429);
  }
  const pw = req.body?.password;
  if (typeof pw !== "string" || !safeEqual(pw, env.ADMIN_PASSWORD)) {
    f.count++;
    console.warn(JSON.stringify({ event: "admin_login_failed" }));
    return error(res, "Unauthorized", 401);
  }
  loginFails.delete(key);
  const sid = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
  sessions.set(sid, { csrf, created: t, last: t });
  res.set("Set-Cookie", `${COOKIE}=${sid}; ${cookieOpts(Math.floor(SESSION_TTL_MS / 1000))}`);
  res.json({ ok: true, csrf });
});
app.post("/api/admin/logout", sameOriginOnly, admin, (req, res) => {
  sessions.delete(req.adminSession);
  res.set("Set-Cookie", `${COOKIE}=; ${cookieOpts(0)}`);
  res.json({ ok: true });
});
app.get("/api/admin/session", admin, (req, res) =>
  res.json({ ok: true, csrf: sessions.get(req.adminSession).csrf }),
);
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
  isAllowedOrigin(req.get("origin")) ?
  next() :
  error(res, "Invalid origin", 403);

// Removal is also used from remove.html, which is served by this backend
// (same-origin), so PUBLIC_ORIGIN is accepted in addition to storefront origins.
// Authorization is the removal token, not the origin.
const allowRemovalOrigin = (req, res, next) => {
  const origin = req.get("origin");
  return isAllowedOrigin(origin) || origin === env.PUBLIC_ORIGIN ?
    next() :
    error(res, "Invalid origin", 403);
};

app.use(cors);
app.use(express.json({
  limit: "12kb"
}));

async function turnstile(token, ip) {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
    remoteip: ip,
  });

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    },
  );

  if (!response.ok) return false;

  const result = await response.json();

  return result.success === true && isAllowedHostname(result.hostname);
}
async function put(key, body, contentType = "image/webp") {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
async function get(key) {
  const r = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key
  }));
  return Buffer.from(await r.Body.transformToByteArray());
}
async function del(key) {
  await s3.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key
  }));
}
async function list(prefix) {
  const out = [];
  let token;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of r.Contents || [])
      out.push({ key: o.Key, size: o.Size, lastModified: o.LastModified });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
// Indirection so tests can replace storage.
export const storage = { put, get, del, list };
app.get("/health", (_req, res) => res.json({
  ok: true
}));
app.get("/api/config", (_req, res) =>
  res.json({
    siteKey: env.TURNSTILE_SITE_KEY,
    consentVersion: CONSENT_VERSION,
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

    if (!row) {
      return error(res, "Not found", 404);
    }

    const image = await storage.get(row.object_key);

    res.set({
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=60",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });

    res.send(image);
  } catch (e) {
    console.error(e);
    error(res, "Image unavailable", 500);
  }
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 1,
    fields: 12
  },
});
const CONSENT_TEXT =
  "Jeg bekrefter at jeg har rett til å dele bildet, og at jeg har " +
  "innhentet nødvendige tillatelser fra personer som kan gjenkjennes i det. " +
  "For bilder av barn bekrefter jeg at jeg er foresatt eller har foresattes " +
  "tillatelse. Jeg gir Barnas Fristed tillatelse til å publisere bildet, " +
  "og navn og beskrivelse hvis jeg har fylt dem ut, i inspirasjonsgalleriet " +
  "på barnasfristed.no. Bildet gjennomgås før publisering. Jeg kan når som " +
  "helst få bildet fjernet med slettelenken jeg får etter opplasting.";
const MARKETING_TEXT =
  "Valgfritt: Jeg gir i tillegg Barnas Fristed tillatelse til å bruke bildet " +
  "i sosiale medier og annonser. Dette er ikke nødvendig for å delta i galleriet, " +
  "og jeg kan trekke samtykket tilbake ved å slette bildet.";
const CONSENT_VERSION = env.CONSENT_VERSION || "2026-10-v2";
app.get("/api/consent", (_req, res) =>
  res.json({ version: CONSENT_VERSION, galleryText: CONSENT_TEXT, marketingText: MARKETING_TEXT }),
);
// ---- Upload limits ---------------------------------------------------------
// Two independent counters in request_limits (keys are salted-free IP hashes):
//  * abuse:<ip>  every POST to /api/submit, counted up front. Stops floods.
//  * quota:<ip>  successful uploads only. Invalid/failed uploads never use it.
// Defaults: 30 attempts / 10 min, 10 successful uploads / 24 h. Override with
// SUBMIT_ABUSE_MAX, SUBMIT_ABUSE_WINDOW_S, SUBMIT_QUOTA_MAX, SUBMIT_QUOTA_WINDOW_S.
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const LIMITS = {
  abuseMax: num(env.SUBMIT_ABUSE_MAX, 30),
  abuseWindow: num(env.SUBMIT_ABUSE_WINDOW_S, 600),
  quotaMax: num(env.SUBMIT_QUOTA_MAX, 10),
  quotaWindow: num(env.SUBMIT_QUOTA_WINDOW_S, 86400),
};
const nowS = () => Math.floor(Date.now() / 1000);
const limitRow = (key) => {
  const r = db.prepare("SELECT count,expires_at FROM request_limits WHERE key=?").get(key);
  return r && r.expires_at > nowS() ? r : null;
};
const hit = (key, windowS) => {
  const t = nowS();
  db.prepare(
    "INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END",
  ).run(key, t + windowS, t, t, t + windowS);
};
const retryAfter = (r) => String(Math.max(1, r.expires_at - nowS()));
const cleanupLimits = () => {
  try {
    db.prepare("DELETE FROM request_limits WHERE expires_at<?").run(nowS());
  } catch (e) {
    console.error(JSON.stringify({ event: "limit_cleanup_failed", message: e?.message }));
  }
};
cleanupLimits();
setInterval(cleanupLimits, 600_000).unref();
const submitAbuseLimit = (req, res, next) => {
  const key = "abuse:" + sha(req.ip || "unknown");
  const r = limitRow(key);
  if (r && r.count >= LIMITS.abuseMax) {
    res.set("Retry-After", retryAfter(r));
    return error(res, "For mange forsøk. Vent noen minutter og prøv igjen.", 429);
  }
  hit(key, LIMITS.abuseWindow);
  next();
};
// Multer errors happen before the route handler; map them to clear messages.
const uploadOne = (req, res, next) =>
  upload.single("image")(req, res, (err) => {
    if (!err) return next();
    console.warn(JSON.stringify({ event: "upload_rejected", code: err.code || "unknown" }));
    if (err.code === "LIMIT_FILE_SIZE")
      return error(res, "Bildet er for stort (maks 8 MB).", 413);
    return error(res, "Ugyldig opplasting.", 400);
  });
// Sharp is memory hungry; cap concurrent image jobs (Fly machine has 1 GB).
sharp.cache(false);
sharp.concurrency(1);
const MAX_PROCESSING = num(env.IMAGE_MAX_CONCURRENCY, 2);
let processing = 0;
const ALLOWED_FORMATS = ["jpeg", "png", "webp", "heif", "avif"];
app.post(
  "/api/submit",
  allowOrigin,
  submitAbuseLimit,
  uploadOne,
  async (req, res) => {
    try {
      const quotaKey = "quota:" + sha(req.ip || "unknown");
      const q = limitRow(quotaKey);
      if (q && q.count >= LIMITS.quotaMax) {
        res.set("Retry-After", retryAfter(q));
        return error(res, "Du har sendt inn mange bilder nylig. Prøv igjen i morgen.", 429);
      }
      if (!(await turnstile(clean(req.body.turnstileToken, 4096), req.ip))) {
        console.warn(JSON.stringify({ event: "turnstile_failed" }));
        return error(res, "Verifiseringen feilet. Last inn siden på nytt og prøv igjen.", 403);
      }
      if (req.body.galleryConsent !== "true")
        return error(res, "Gallery permission required");
      if (req.body.consentVersion !== CONSENT_VERSION)
        return error(res, "Samtykketeksten er oppdatert. Last siden på nytt og prøv igjen.", 409);
      if (!req.file) return error(res, "Image required");
      const product0 = clean(req.body.productHandle, 120);
      if (product0 && !/^[a-z0-9-]+$/.test(product0))
        return error(res, "Invalid product");
      if (processing >= MAX_PROCESSING) {
        res.set("Retry-After", "10");
        return error(res, "Serveren er opptatt. Prøv igjen om litt.", 503);
      }
      processing++;
      let bytes;
      try {
        // Decode and re-encode on the server: validates the real format (not
        // the MIME header), caps decoded pixels, and strips EXIF/metadata.
        const img = sharp(req.file.buffer, {
          limitInputPixels: 25_000_000,
          failOn: "error",
        });
        const meta = await img.metadata();
        if (!ALLOWED_FORMATS.includes(meta.format))
          return error(res, "Ugyldig bildeformat. Bruk JPG, PNG eller WebP.");
        bytes = await img
          .rotate()
          .resize({
            width: 2200,
            height: 2200,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({
            quality: 82
          })
          .toBuffer();
      } catch (e) {
        console.warn(JSON.stringify({ event: "image_rejected", message: e?.message }));
        return error(res, "Ugyldig eller skadet bilde.", 400);
      } finally {
        processing--;
      }
      const id = randomUUID(),
        token = randomUUID() + randomUUID(),
        key = `photos/${id}.webp`;
      const product = clean(req.body.productHandle, 120);
      if (product && !/^[a-z0-9-]+$/.test(product))
        return error(res, "Invalid product");
      const marketing = req.body.marketingConsent === "true" ? 1 : 0,
        version = CONSENT_VERSION,
        // Record exactly the text(s) the customer saw and agreed to.
        consentRecord = marketing ? `${CONSENT_TEXT}\n---\n${MARKETING_TEXT}` : CONSENT_TEXT,
        timestamp = now();
      try {
        await storage.put(key, bytes);
      } catch (e) {
        console.error(JSON.stringify({ event: "storage_put_failed", message: e?.message }));
        return error(res, "Kunne ikke lagre bildet. Prøv igjen senere.", 502);
      }
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
            consentRecord,
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
            consentRecord,
            marketing,
            timestamp,
          );
        })();
      } catch (e) {
        try {
          await storage.del(key);
        } catch {
          console.error(JSON.stringify({ event: "orphan_object", key }));
        }
        throw e;
      }
      hit(quotaKey, LIMITS.quotaWindow); // only successful uploads use the quota
      res.status(201).json({
        ok: true,
        id,
        removalToken: token,
        message: "Bildet er sendt til godkjenning.",
      });
    } catch (e) {
      console.error(JSON.stringify({ event: "submit_failed", message: e?.message }));
      error(res, "Noe gikk galt under opplasting. Prøv igjen senere.", 500);
    }
  },
);
app.get("/remove.html", (_req, res) =>
  res.type("html").send(readFileSync(path.join(root, "remove.html"), "utf8")),
);
// Preview for the owner of a removal link (works while the photo is still
// pending/rejected, when /images/:id is not public). Token goes in the POST
// body, never in a URL, and the response is not cacheable.
app.post("/api/remove/preview", allowRemovalOrigin, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { id, token } = req.body || {};
  if (typeof id !== "string" || typeof token !== "string" || !id || !token)
    return error(res, "Invalid removal link", 403);
  const row = db
    .prepare("SELECT object_key,removal_token_hash,status FROM photos WHERE id=?")
    .get(id);
  const expected = Buffer.from(row?.removal_token_hash || sha("none"), "hex");
  if (!row || !timingSafeEqual(Buffer.from(sha(token), "hex"), expected))
    return error(res, "Invalid removal link", 403);
  if (row.status === "deleted") return error(res, "Already removed", 410);
  try {
    const image = await storage.get(row.object_key);
    res.set({
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "X-Photo-Status": row.status,
    });
    res.send(image);
  } catch (e) {
    console.error(
      JSON.stringify({ event: "removal_preview_failed", photoId: id, message: e?.message }),
    );
    error(res, "Preview unavailable", 500);
  }
});
// Customer removal. Order matters: unpublish in the DB first (so the image can
// never be served again), then delete the object, then mark storage as deleted.
// If object deletion fails the request returns 202 and a retry completes it.
app.post("/api/remove", allowRemovalOrigin, async (req, res) => {
  const { id, token } = req.body || {};
  if (typeof id !== "string" || typeof token !== "string" || !id || !token)
    return error(res, "Invalid removal link", 403);
  const row = db
    .prepare(
      "SELECT object_key,removal_token_hash,status,storage_deleted_at FROM photos WHERE id=?",
    )
    .get(id);
  const expected = Buffer.from(row?.removal_token_hash || sha("none"), "hex");
  const given = Buffer.from(sha(token), "hex");
  if (!row || !timingSafeEqual(given, expected))
    return error(res, "Invalid removal link", 403);
  if (row.status === "deleted" && row.storage_deleted_at)
    return res.json({ ok: true, alreadyRemoved: true });
  if (row.status !== "deleted") {
    db.transaction(() => {
      db.prepare("UPDATE photos SET status='deleted',deleted_at=? WHERE id=?").run(now(), id);
      db.prepare(
        "INSERT INTO consent_events(id,photo_id,action,version,consent_text,marketing_consent,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        randomUUID(),
        id,
        "withdrawn",
        CONSENT_VERSION,
        "Withdrawal",
        0,
        now(),
      );
    })();
  }
  try {
    await storage.del(row.object_key);
    db.prepare("UPDATE photos SET storage_deleted_at=? WHERE id=?").run(now(), id);
  } catch (e) {
    console.error(
      JSON.stringify({ event: "storage_delete_failed", photoId: id, message: e?.message }),
    );
    return res.status(202).json({
      ok: true,
      pending: true,
      message: "Bildet er fjernet fra galleriet. Sletting fullføres; prøv igjen senere.",
    });
  }
  res.json({ ok: true });
});
app.get("/admin", (_req, res) =>
  res.type("html").send(readFileSync(path.join(root, "admin.html"), "utf8")),
);
app.get("/api/admin/photos", admin, (req, res) => {
  const status = ["pending", "approved", "rejected"].includes(req.query.status) ?
    req.query.status :
    "pending";
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
    res.set("Content-Type", "image/webp").send(await storage.get(row.object_key));
  } catch (e) {
    console.error(e);
    error(res, "Unavailable", 500);
  }
});
app.post("/api/admin/photos/:id/:action", admin, async (req, res) => {
  const {
    id,
    action
  } = req.params;
  if (!["approve", "reject", "delete"].includes(action))
    return error(res, "Invalid action");
  const row = db.prepare("SELECT object_key,status FROM photos WHERE id=?").get(id);
  if (!row) return error(res, "Not found", 404);
  if (row.status === "deleted" && action !== "delete")
    return error(res, "Photo already deleted", 409);
  const status = {
    approve: "approved",
    reject: "rejected",
    delete: "deleted"
  } [
    action
  ];
  db.prepare(
    "UPDATE photos SET status=?,approved_at=CASE WHEN ?='approved' THEN ? ELSE approved_at END,deleted_at=CASE WHEN ?='deleted' THEN ? ELSE deleted_at END WHERE id=?",
  ).run(status, status, now(), status, now(), id);
  if (action === "delete") {
    await storage.del(row.object_key);
    db.prepare("UPDATE photos SET storage_deleted_at=? WHERE id=?").run(now(), id);
  }
  res.json({
    ok: true,
    status
  });
});
// ---- Maintenance (admin only) ---------------------------------------------
const BACKUP_KEEP = num(env.BACKUP_KEEP, 14);
const maint = () => ({ db, storage, dataDir, keep: BACKUP_KEEP });
app.post("/api/admin/backup", sameOriginOnly, admin, async (_req, res) => {
  try {
    const r = await backupDatabase(maint());
    console.log(JSON.stringify({ event: "backup_ok", key: r.key, bytes: r.bytes, pruned: r.pruned, manual: true }));
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error(JSON.stringify({ event: "backup_failed", message: e?.message }));
    error(res, "Backup failed", 500);
  }
});
app.get("/api/admin/maintenance/reconcile", admin, async (_req, res) => {
  try {
    res.json(await reconcile({ db, storage }));
  } catch (e) {
    console.error(JSON.stringify({ event: "reconcile_failed", message: e?.message }));
    error(res, "Reconcile failed", 500);
  }
});
app.post("/api/admin/maintenance/retry-deletions", sameOriginOnly, admin, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await retryDeletions({ db, storage })) });
  } catch (e) {
    console.error(JSON.stringify({ event: "retry_deletions_failed", message: e?.message }));
    error(res, "Retry failed", 500);
  }
});
// Daily automatic backup. Checks hourly so a restart never skips or duplicates one.
if (process.env.NODE_ENV !== "test" && !process.env.NO_LISTEN && env.BACKUP_ENABLED !== "false") {
  const tick = async () => {
    try {
      const r = await backupIfDue({ ...maint(), intervalHours: num(env.BACKUP_INTERVAL_HOURS, 24) });
      if (r) console.log(JSON.stringify({ event: "backup_ok", key: r.key, bytes: r.bytes, pruned: r.pruned }));
    } catch (e) {
      console.error(JSON.stringify({ event: "backup_failed", message: e?.message }));
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 3600_000).unref();
}
export { app, db };
if (process.env.NODE_ENV !== "test" && !process.env.NO_LISTEN)
  app.listen(Number(env.PORT || 8080), "0.0.0.0", () => console.log("Listening"));