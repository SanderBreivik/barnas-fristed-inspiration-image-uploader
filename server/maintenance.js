// Backup, restore-verification and storage-reconciliation helpers.
// Pure functions: dependencies (db, storage) are passed in so tests can mock them.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export const BACKUP_PREFIX = "backups/";
const BACKUP_KEY = /^backups\/photos-(\d{8})T(\d{6})Z\.sqlite\.gz$/;

const stamp = (d = new Date()) =>
  d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

const keyTime = (key) => {
  const m = BACKUP_KEY.exec(key);
  if (!m) return null;
  const [, d, t] = m;
  return Date.parse(
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}Z`,
  );
};

export async function listBackups(storage) {
  return (await storage.list(BACKUP_PREFIX))
    .map((o) => o.key)
    .filter((k) => BACKUP_KEY.test(k))
    .sort();
}

// SQLite-consistent snapshot (uses the online backup API, safe while serving),
// gzipped, uploaded to the private bucket under backups/, plus one local copy
// on the volume that can be fetched with `fly ssh sftp get`.
export async function backupDatabase({ db, storage, dataDir, keep = 14 }) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bf-backup-"));
  try {
    const file = path.join(tmp, "photos.sqlite");
    await db.backup(file);
    const gz = gzipSync(readFileSync(file));
    const key = `${BACKUP_PREFIX}photos-${stamp()}.sqlite.gz`;
    await storage.put(key, gz, "application/gzip");
    const localDir = path.join(dataDir, "backups");
    mkdirSync(localDir, { recursive: true });
    const localTmp = path.join(localDir, "latest.sqlite.gz.tmp");
    writeFileSync(localTmp, gz);
    renameSync(localTmp, path.join(localDir, "latest.sqlite.gz"));
    const pruned = await pruneBackups({ storage, keep });
    return { key, bytes: gz.length, pruned };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Deletes only objects matching the backup naming pattern, oldest first.
export async function pruneBackups({ storage, keep = 14 }) {
  const keys = await listBackups(storage);
  const old = keys.slice(0, Math.max(0, keys.length - keep));
  for (const k of old) await storage.del(k);
  return old.length;
}

export async function backupIfDue({ db, storage, dataDir, keep, intervalHours = 24 }) {
  const keys = await listBackups(storage);
  const newest = keys.length ? keyTime(keys[keys.length - 1]) : null;
  if (newest && Date.now() - newest < intervalHours * 3600_000) return null;
  return backupDatabase({ db, storage, dataDir, keep });
}

// Restore check: unpack a backup into a scratch file, run SQLite's integrity
// check and return row counts. Never touches the live database.
export function verifyBackup(gzBuffer, { restoreTo } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bf-verify-"));
  try {
    const file = path.join(tmp, "restored.sqlite");
    writeFileSync(file, gunzipSync(gzBuffer));
    const db = new Database(file, { readonly: true });
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      const byStatus = Object.fromEntries(
        db.prepare("SELECT status,count(*) c FROM photos GROUP BY status").all().map((r) => [r.status, r.c]),
      );
      const result = {
        ok: integrity === "ok",
        integrity,
        photos: byStatus,
        consentEvents: db.prepare("SELECT count(*) c FROM consent_events").get().c,
        newestSubmission: db.prepare("SELECT max(submitted_at) m FROM photos").get().m,
      };
      if (restoreTo && result.ok) {
        mkdirSync(path.dirname(path.resolve(restoreTo)), { recursive: true });
        writeFileSync(restoreTo, readFileSync(file));
        result.restoredTo = path.resolve(restoreTo);
      }
      return result;
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Compare database rows with objects under photos/. Read-only.
export async function reconcile({ db, storage }) {
  const objects = new Set((await storage.list("photos/")).map((o) => o.key));
  const rows = db.prepare("SELECT id,object_key,status FROM photos").all();
  const known = new Set(rows.map((r) => r.object_key));
  const missingObjects = [];
  const pendingDeletions = [];
  for (const r of rows) {
    if (r.status === "deleted") {
      if (objects.has(r.object_key)) pendingDeletions.push(r.id);
    } else if (!objects.has(r.object_key)) {
      missingObjects.push(r.id);
    }
  }
  const orphanObjects = [...objects].filter((k) => !known.has(k));
  return {
    objects: objects.size,
    rows: rows.length,
    missingObjects, // DB says it exists, storage does not (restore from backup/bucket)
    pendingDeletions, // customer/admin deleted, object still in storage
    orphanObjects, // object with no DB row (e.g. failed insert); reported only
  };
}

// Finishes deletions the customer or admin already requested. Safe by policy:
// the photo is already marked deleted and unpublished.
export async function retryDeletions({ db, storage }) {
  const report = await reconcile({ db, storage });
  let done = 0;
  const failed = [];
  for (const id of report.pendingDeletions) {
    const row = db.prepare("SELECT object_key FROM photos WHERE id=?").get(id);
    try {
      await storage.del(row.object_key);
      db.prepare("UPDATE photos SET storage_deleted_at=? WHERE id=?").run(new Date().toISOString(), id);
      done++;
    } catch {
      failed.push(id);
    }
  }
  return { done, failed };
}

const DAY = 86_400_000;

// Retention enforcement. Defaults follow the draft policy in README.md and
// must be approved by the owner before RETENTION_ENABLED is switched on.
//  - pending/rejected photos older than `pendingDays` are expired (unpublished,
//    consent event "expired", object deleted from storage)
//  - personal text (name, description) is scrubbed from deleted rows after `scrubDays`
//  - consent log entries of deleted photos older than `consentDays` are removed
// With apply=false nothing is changed; the report shows what would happen.
export async function enforceRetention({
  db,
  storage,
  apply = false,
  now = Date.now(),
  pendingDays = 30,
  scrubDays = 30,
  consentDays = 1095,
  batch = 200,
  version = "retention",
}) {
  const iso = (days) => new Date(now - days * DAY).toISOString();
  const ts = new Date(now).toISOString();
  const expiring = db
    .prepare(
      "SELECT id,object_key FROM photos WHERE status IN ('pending','rejected') AND submitted_at < ? ORDER BY submitted_at LIMIT ?",
    )
    .all(iso(pendingDays), batch);
  const scrubSql =
    "FROM photos WHERE status='deleted' AND storage_deleted_at IS NOT NULL AND deleted_at < ? AND (display_name IS NOT NULL OR description IS NOT NULL)";
  const scrubCount = db.prepare(`SELECT count(*) c ${scrubSql}`).get(iso(scrubDays)).c;
  const consentSql =
    "FROM consent_events WHERE created_at < ? AND photo_id IN (SELECT id FROM photos WHERE status='deleted' AND storage_deleted_at IS NOT NULL)";
  const consentCount = db.prepare(`SELECT count(*) c ${consentSql}`).get(iso(consentDays)).c;

  const report = {
    apply,
    expiredPhotos: expiring.length,
    scrubbedRows: scrubCount,
    purgedConsentEvents: consentCount,
    storageFailures: [],
  };
  if (!apply) return report;

  for (const p of expiring) {
    db.transaction(() => {
      db.prepare("UPDATE photos SET status='deleted',deleted_at=? WHERE id=?").run(ts, p.id);
      db.prepare(
        "INSERT INTO consent_events(id,photo_id,action,version,consent_text,marketing_consent,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(randomUUID(), p.id, "expired", version, "Retention period ended", 0, ts);
    })();
    try {
      await storage.del(p.object_key);
      db.prepare("UPDATE photos SET storage_deleted_at=? WHERE id=?").run(ts, p.id);
    } catch {
      report.storageFailures.push(p.id); // retryDeletions finishes it later
    }
  }
  db.prepare(
    `UPDATE photos SET display_name=NULL,description=NULL WHERE id IN (SELECT id ${scrubSql})`,
  ).run(iso(scrubDays));
  db.prepare(`DELETE ${consentSql}`).run(iso(consentDays));
  return report;
}

