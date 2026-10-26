// Admin page, moderation actions and maintenance endpoints (all behind `admin`).
import { Router } from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { root } from "../config.js";
import { db } from "../db.js";
import { storage } from "../storage.js";
import { now, error } from "../util.js";
import { log, errFields } from "../log.js";
import { admin } from "../auth.js";
import { sameOriginOnly } from "../origins.js";
import { removeThumb } from "../images.js";
import { backupDatabase, enforceRetention, reconcile, retryDeletions } from "../maintenance.js";
import { maint, retentionOpts, logRetention } from "../jobs.js";

export const adminRouter = Router();

adminRouter.get("/admin", (_req, res) =>
  res.type("html").send(readFileSync(path.join(root, "admin.html"), "utf8")),
);

adminRouter.get("/api/admin/photos", admin, (req, res) => {
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

adminRouter.get("/api/admin/preview/:id", admin, async (req, res) => {
  try {
    const row = db.prepare("SELECT object_key FROM photos WHERE id=?").get(req.params.id);
    if (!row) return error(res, "Not found", 404);
    res.set("Content-Type", "image/webp").send(await storage.get(row.object_key));
  } catch (e) {
    log.error("admin_preview_failed", errFields(e));
    error(res, "Unavailable", 500);
  }
});

adminRouter.post("/api/admin/photos/:id/:action", admin, async (req, res) => {
  const { id, action } = req.params;
  if (!["approve", "reject", "delete"].includes(action)) return error(res, "Invalid action");
  const row = db.prepare("SELECT object_key,status FROM photos WHERE id=?").get(id);
  if (!row) return error(res, "Not found", 404);
  if (row.status === "deleted" && action !== "delete")
    return error(res, "Photo already deleted", 409);
  const status = { approve: "approved", reject: "rejected", delete: "deleted" }[action];
  db.prepare(
    "UPDATE photos SET status=?,approved_at=CASE WHEN ?='approved' THEN ? ELSE approved_at END,deleted_at=CASE WHEN ?='deleted' THEN ? ELSE deleted_at END WHERE id=?",
  ).run(status, status, now(), status, now(), id);
  if (status !== "approved") removeThumb(id);
  if (action === "delete") {
    try {
      await storage.del(row.object_key);
      db.prepare("UPDATE photos SET storage_deleted_at=? WHERE id=?").run(now(), id);
    } catch (e) {
      // Already unpublished; "Fullfør ventende slettinger" in /admin retries it.
      log.error("storage_delete_failed", { photoId: id, source: "admin", ...errFields(e) });
      return res.status(202).json({ ok: true, status, pending: true });
    }
  }
  res.json({ ok: true, status });
});

// ---- Maintenance ----------------------------------------------------------
adminRouter.post("/api/admin/backup", sameOriginOnly, admin, async (_req, res) => {
  try {
    const r = await backupDatabase(maint());
    log.info("backup_ok", { objectKey: r.key, bytes: r.bytes, pruned: r.pruned, manual: true });
    res.json({ ok: true, ...r });
  } catch (e) {
    log.error("backup_failed", errFields(e));
    error(res, "Backup failed", 500);
  }
});

adminRouter.get("/api/admin/maintenance/reconcile", admin, async (_req, res) => {
  try {
    res.json(await reconcile({ db, storage }));
  } catch (e) {
    log.error("reconcile_failed", errFields(e));
    error(res, "Reconcile failed", 500);
  }
});

adminRouter.post("/api/admin/maintenance/retry-deletions", sameOriginOnly, admin, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await retryDeletions({ db, storage })) });
  } catch (e) {
    log.error("retry_deletions_failed", errFields(e));
    error(res, "Retry failed", 500);
  }
});

// Retention (see README). Preview by default; `{"apply":true}` really deletes.
adminRouter.post("/api/admin/maintenance/retention", sameOriginOnly, admin, async (req, res) => {
  try {
    const apply = req.body?.apply === true;
    const r = await enforceRetention({ ...retentionOpts(), apply });
    if (apply) logRetention(r);
    res.json({ ok: true, ...r });
  } catch (e) {
    log.error("retention_failed", errFields(e));
    error(res, "Retention failed", 500);
  }
});
