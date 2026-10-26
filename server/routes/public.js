// Public read-only endpoints: health, config, consent texts, gallery, images.
import { Router } from "express";
import { env, num } from "../config.js";
import { db } from "../db.js";
import { storage } from "../storage.js";
import { error } from "../util.js";
import { log, errFields } from "../log.js";
import { CONSENT_TEXT, MARKETING_TEXT, CONSENT_VERSION } from "../consent.js";

export const publicRouter = Router();

publicRouter.get("/health", (_req, res) => res.json({ ok: true }));

// Dependency check (database + object storage). Cached briefly so uptime
// monitors cannot turn it into load. Returns booleans only, no details.
let healthCache = { at: 0, result: null };
async function deepHealth() {
  const ttl = num(env.HEALTH_CACHE_MS, 30_000);
  if (healthCache.result && Date.now() - healthCache.at < ttl) return healthCache.result;
  const result = { db: false, storage: false };
  try {
    db.prepare("SELECT 1").get();
    result.db = true;
  } catch (e) {
    log.error("db_error", errFields(e));
  }
  try {
    await storage.list("photos/", 1);
    result.storage = true;
  } catch (e) {
    log.error("storage_health_failed", errFields(e));
  }
  result.ok = result.db && result.storage;
  healthCache = { at: Date.now(), result };
  return result;
}
publicRouter.get("/health/deep", async (_req, res) => {
  const r = await deepHealth();
  res.status(r.ok ? 200 : 503).json(r);
});

publicRouter.get("/api/config", (_req, res) =>
  res.json({ siteKey: env.TURNSTILE_SITE_KEY, consentVersion: CONSENT_VERSION }),
);

publicRouter.get("/api/consent", (_req, res) =>
  res.json({ version: CONSENT_VERSION, galleryText: CONSENT_TEXT, marketingText: MARKETING_TEXT }),
);

publicRouter.get("/api/gallery", (req, res) => {
  const page = Math.max(0, Math.min(100, Number.parseInt(req.query.page, 10) || 0));
  const photos = db
    .prepare(
      "SELECT id,display_name,description,product_handle,approved_at FROM photos WHERE status='approved' ORDER BY approved_at DESC LIMIT 24 OFFSET ?",
    )
    .all(page * 24);
  res.json({
    photos: photos.map((p) => ({ ...p, imageUrl: `${env.PUBLIC_ORIGIN}/images/${p.id}` })),
    nextPage: photos.length === 24 ? page + 1 : null,
  });
});

publicRouter.get("/images/:id", async (req, res) => {
  try {
    const row = db
      .prepare("SELECT object_key FROM photos WHERE id=? AND status='approved'")
      .get(req.params.id);
    if (!row) return error(res, "Not found", 404);
    const image = await storage.get(row.object_key);
    res.set({
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=60",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(image);
  } catch (e) {
    log.error("image_serve_failed", errFields(e));
    error(res, "Image unavailable", 500);
  }
});
