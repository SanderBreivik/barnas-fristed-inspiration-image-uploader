// Customer removal: remove.html, token-authorised preview, and removal itself.
import { Router } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { root } from "../config.js";
import { db } from "../db.js";
import { storage } from "../storage.js";
import { sha, now, error } from "../util.js";
import { log, errFields } from "../log.js";
import { CONSENT_VERSION } from "../consent.js";
import { allowRemovalOrigin } from "../origins.js";
import { removeThumb } from "../images.js";

export const removalRouter = Router();

removalRouter.get("/remove.html", (_req, res) =>
  res.type("html").send(readFileSync(path.join(root, "remove.html"), "utf8")),
);

// Preview for the owner of a removal link (works while the photo is still
// pending/rejected, when /images/:id is not public). Token goes in the POST
// body, never in a URL, and the response is not cacheable.
removalRouter.post("/api/remove/preview", allowRemovalOrigin, async (req, res) => {
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
    log.error("removal_preview_failed", { photoId: id, ...errFields(e) });
    error(res, "Preview unavailable", 500);
  }
});

// Customer removal. Order matters: unpublish in the DB first (so the image can
// never be served again), then delete the object, then mark storage as deleted.
// If object deletion fails the request returns 202 and a retry completes it.
removalRouter.post("/api/remove", allowRemovalOrigin, async (req, res) => {
  const { id, token } = req.body || {};
  if (typeof id !== "string" || typeof token !== "string" || !id || !token)
    return error(res, "Invalid removal link", 403);
  const row = db
    .prepare("SELECT object_key,removal_token_hash,status,storage_deleted_at FROM photos WHERE id=?")
    .get(id);
  const expected = Buffer.from(row?.removal_token_hash || sha("none"), "hex");
  const given = Buffer.from(sha(token), "hex");
  if (!row || !timingSafeEqual(given, expected)) return error(res, "Invalid removal link", 403);
  if (row.status === "deleted" && row.storage_deleted_at)
    return res.json({ ok: true, alreadyRemoved: true });
  if (row.status !== "deleted") {
    db.transaction(() => {
      db.prepare("UPDATE photos SET status='deleted',deleted_at=? WHERE id=?").run(now(), id);
      db.prepare(
        "INSERT INTO consent_events(id,photo_id,action,version,consent_text,marketing_consent,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(randomUUID(), id, "withdrawn", CONSENT_VERSION, "Withdrawal", 0, now());
    })();
  }
  try {
    await storage.del(row.object_key);
    removeThumb(id);
    db.prepare("UPDATE photos SET storage_deleted_at=? WHERE id=?").run(now(), id);
  } catch (e) {
    log.error("storage_delete_failed", { photoId: id, source: "customer", ...errFields(e) });
    return res.status(202).json({
      ok: true,
      pending: true,
      message: "Bildet er fjernet fra galleriet. Sletting fullføres; prøv igjen senere.",
    });
  }
  res.json({ ok: true });
});
