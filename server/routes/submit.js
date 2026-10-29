// POST /api/submit: validate, re-encode the image, store it and record consent.
import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { env, num } from "../config.js";
import { db } from "../db.js";
import { storage } from "../storage.js";
import { sha, now, clean, error } from "../util.js";
import { log, errFields } from "../log.js";
import { CONSENT_TEXT, MARKETING_TEXT, CONSENT_VERSION } from "../consent.js";
import { allowOrigin } from "../origins.js";
import { turnstile } from "../turnstile.js";
import { LIMITS, limitRow, hit, retryAfter, submitAbuseLimit } from "../limits.js";

export const submitRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 12 },
});

// Multer errors happen before the route handler; map them to clear messages.
const uploadOne = (req, res, next) =>
  upload.single("image")(req, res, (err) => {
    if (!err) return next();
    log.warn("upload_rejected", { code: err.code || "unknown" });
    if (err.code === "LIMIT_FILE_SIZE") return error(res, "Bildet er for stort (maks 8 MB).", 413);
    return error(res, "Ugyldig opplasting.", 400);
  });

// Sharp is memory hungry; cap concurrent image jobs (Fly machine has 1 GB).
sharp.cache(false);
sharp.concurrency(1);
const MAX_PROCESSING = num(env.IMAGE_MAX_CONCURRENCY, 2);
let processing = 0;
const ALLOWED_FORMATS = ["jpeg", "png", "webp", "heif", "avif"];

// Checks shared by image and video uploads. Sends the error response itself and
// returns null when the upload must be refused.
export async function admit(req, res, fileMessage) {
  const quotaKey = "quota:" + sha(req.ip || "unknown");
  const q = limitRow(quotaKey);
  if (q && q.count >= LIMITS.quotaMax) {
    res.set("Retry-After", retryAfter(q));
    error(res, "Du har sendt inn mange bilder eller videoer nylig. Prøv igjen i morgen.", 429);
    return null;
  }
  if (!(await turnstile(clean(req.body.turnstileToken, 4096), req.ip))) {
    log.warn("turnstile_failed");
    error(res, "Verifiseringen feilet. Last inn siden på nytt og prøv igjen.", 403);
    return null;
  }
  if (req.body.galleryConsent !== "true") {
    error(res, "Gallery permission required");
    return null;
  }
  if (req.body.consentVersion !== CONSENT_VERSION) {
    error(res, "Samtykketeksten er oppdatert. Last siden på nytt og prøv igjen.", 409);
    return null;
  }
  if (!req.file) {
    error(res, fileMessage);
    return null;
  }
  const product = clean(req.body.productHandle, 120);
  if (product && !/^[a-z0-9-]+$/.test(product)) {
    error(res, "Invalid product");
    return null;
  }
  return { quotaKey, product };
}

// Inserts the photo row and its "submitted" consent event in one transaction.
export function record(
  req,
  { id, token, key, product, width, height, media = "image", durationMs = null, keepAudio = false },
) {
  const marketing = req.body.marketingConsent === "true" ? 1 : 0,
    // Record exactly the text(s) the customer saw and agreed to.
    consentRecord = marketing ? `${CONSENT_TEXT}\n---\n${MARKETING_TEXT}` : CONSENT_TEXT,
    timestamp = now();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO photos(id,object_key,display_name,description,product_handle,status,gallery_consent,marketing_consent,consent_version,consent_text,submitted_at,removal_token_hash,width,height,media_type,media_status,duration_ms,keep_audio) VALUES(?,?,?,?,?,'pending',1,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      key,
      clean(req.body.displayName, 80),
      clean(req.body.description, 500),
      product || null,
      marketing,
      CONSENT_VERSION,
      consentRecord,
      timestamp,
      sha(token),
      width ?? null,
      height ?? null,
      media,
      media === "video" ? "processing" : "ready",
      durationMs,
      keepAudio ? 1 : 0,
    );
    db.prepare(
      "INSERT INTO consent_events(id,photo_id,action,version,consent_text,marketing_consent,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(randomUUID(), id, "submitted", CONSENT_VERSION, consentRecord, marketing, timestamp);
  })();
}

submitRouter.post("/api/submit", allowOrigin, submitAbuseLimit, uploadOne, async (req, res) => {
  try {
    const ctx = await admit(req, res, "Image required");
    if (!ctx) return;
    const { quotaKey, product } = ctx;
    if (processing >= MAX_PROCESSING) {
      res.set("Retry-After", "10");
      return error(res, "Serveren er opptatt. Prøv igjen om litt.", 503);
    }
    processing++;
    let bytes, dims;
    try {
      // Decode and re-encode on the server: validates the real format (not
      // the MIME header), caps decoded pixels, and strips EXIF/metadata.
      const img = sharp(req.file.buffer, { limitInputPixels: 25_000_000, failOn: "error" });
      const meta = await img.metadata();
      if (!ALLOWED_FORMATS.includes(meta.format))
        return error(res, "Ugyldig bildeformat. Bruk JPG, PNG eller WebP.");
      const out = await img
        .rotate()
        .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      bytes = out.data;
      dims = out.info;
    } catch (e) {
      log.warn("image_rejected", errFields(e));
      return error(res, "Ugyldig eller skadet bilde.", 400);
    } finally {
      processing--;
    }
    const id = randomUUID(),
      token = randomUUID() + randomUUID(),
      key = `photos/${id}.webp`;
    try {
      await storage.put(key, bytes);
    } catch (e) {
      log.error("storage_put_failed", errFields(e));
      return error(res, "Kunne ikke lagre bildet. Prøv igjen senere.", 502);
    }
    try {
      record(req, { id, token, key, product, width: dims.width, height: dims.height });
    } catch (e) {
      try {
        await storage.del(key);
      } catch {
        log.error("orphan_object", { objectKey: key });
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
    log.error("submit_failed", errFields(e));
    error(res, "Noe gikk galt under opplasting. Prøv igjen senere.", 500);
  }
});
