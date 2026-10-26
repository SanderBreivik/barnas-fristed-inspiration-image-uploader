// Background jobs and the settings shared by the maintenance endpoints.
import { backupIfDue, enforceRetention } from "./maintenance.js";
import { env, num, dataDir } from "./config.js";
import { db } from "./db.js";
import { storage } from "./storage.js";
import { CONSENT_VERSION } from "./consent.js";
import { log, errFields } from "./log.js";

export const maint = () => ({ db, storage, dataDir, keep: num(env.BACKUP_KEEP, 14) });

export const retentionOpts = () => ({
  db,
  storage,
  pendingDays: num(env.RETENTION_PENDING_DAYS, 30),
  scrubDays: num(env.RETENTION_SCRUB_DAYS, 30),
  consentDays: num(env.RETENTION_CONSENT_DAYS, 1095),
  version: CONSENT_VERSION,
});

export const logRetention = (r) =>
  log.info("retention_applied", {
    expired: r.expiredPhotos,
    scrubbed: r.scrubbedRows,
    consentPurged: r.purgedConsentEvents,
    failures: r.storageFailures.length,
  });

// Daily automatic backup. Checks hourly so a restart never skips or duplicates one.
// Retention is opt-in: nothing is deleted automatically until RETENTION_ENABLED=true.
export function startBackgroundJobs() {
  if (env.BACKUP_ENABLED === "false") return;
  const tick = async () => {
    try {
      const r = await backupIfDue({ ...maint(), intervalHours: num(env.BACKUP_INTERVAL_HOURS, 24) });
      if (r) log.info("backup_ok", { objectKey: r.key, bytes: r.bytes, pruned: r.pruned });
    } catch (e) {
      log.error("backup_failed", errFields(e));
    }
    if (env.RETENTION_ENABLED === "true") {
      try {
        const r = await enforceRetention({ ...retentionOpts(), apply: true });
        if (r.expiredPhotos || r.scrubbedRows || r.purgedConsentEvents || r.storageFailures.length)
          logRetention(r);
      } catch (e) {
        log.error("retention_failed", errFields(e));
      }
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 3600_000).unref();
}
