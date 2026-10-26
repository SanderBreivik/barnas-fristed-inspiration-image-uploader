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

submitRouter.post("/api/submit", allowOrigin, submitAbuseLimit, uploadOne, async (req, res) => {
  try {
    const quotaKey = "quota:" + sha(req.ip || "unknown");
    const q = limitRow(quotaKey);
    if (q && q.count >= LIMITS.quotaMax) {
      res.set("Retry-After", retryAfter(q));
      return error(res, "Du har sendt inn mange bilder nylig. Prøv igjen i morgen.", 429);
    }
    if (!(await turnstile(clean(req.body.turnstileToken, 4096), req.ip))) {
      log.warn("turnstile_failed");
      return error(res, "Verifiseringen feilet. Last inn siden på nytt og prøv igjen.", 403);
    }
    if (req.body.galleryConsent !== "true") return error(res, "Gallery permission required");
    if (req.body.consentVersion !== CONSENT_VERSION)
      return error(res, "Samtykketeksten er oppdatert. Last siden på nytt og prøv igjen.", 409);
    if (!req.file) return error(res, "Image required");
    const product = clean(req.body.productHandle, 120);
    if (product && !/^[a-z0-9-]+$/.test(product)) return error(res, "Invalid product");
    if (processing >= MAX_PROCESSING) {
      res.set("Retry-After", "10");
      return error(res, "Serveren er opptatt. Prøv igjen om litt.", 503);
    }
    processing++;
    let bytes;
    try {
      // Decode and re-encode on the server: validates the real format (not
      // the MIME header), caps decoded pixels, and strips EXIF/metadata.
      const img = sharp(req.file.buffer, { limitInputPixels: 25_000_000, failOn: "error" });
      const meta = await img.metadata();
      if (!ALLOWED_FORMATS.includes(meta.format))
        return error(res, "Ugyldig bildeformat. Bruk JPG, PNG eller WebP.");
      bytes = await img
        .rotate()
        .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
    } catch (e) {
      log.warn("image_rejected", errFields(e));
      return error(res, "Ugyldig eller skadet bilde.", 400);
    } finally {
      processing--;
    }
    const id = randomUUID(),
      token = randomUUID() + randomUUID(),
      key = `photos/${id}.webp`;
    const marketing = req.body.marketingConsent === "true" ? 1 : 0,
      version = CONSENT_VERSION,
      // Record exactly the text(s) the customer saw and agreed to.
      consentRecord = marketing ? `${CONSENT_TEXT}\n---\n${MARKETING_TEXT}` : CONSENT_TEXT,
      timestamp = now();
    try {
      await storage.put(key, bytes);
    } catch (e) {
      log.error("storage_put_failed", errFields(e));
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
        ).run(randomUUID(), id, "submitted", version, consentRecord, marketing, timestamp);
      })();
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
