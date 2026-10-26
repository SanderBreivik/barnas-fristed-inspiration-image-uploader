// Upload limits. Two independent counters in request_limits (keys are IP hashes):
//  * abuse:<ip>  every POST to /api/submit, counted up front. Stops floods.
//  * quota:<ip>  successful uploads only. Invalid/failed uploads never use it.
// Defaults: 30 attempts / 10 min, 10 successful uploads / 24 h. Override with
// SUBMIT_ABUSE_MAX, SUBMIT_ABUSE_WINDOW_S, SUBMIT_QUOTA_MAX, SUBMIT_QUOTA_WINDOW_S.
import { env, num } from "./config.js";
import { db } from "./db.js";
import { sha, error } from "./util.js";
import { log, errFields } from "./log.js";

export const LIMITS = {
  abuseMax: num(env.SUBMIT_ABUSE_MAX, 30),
  abuseWindow: num(env.SUBMIT_ABUSE_WINDOW_S, 600),
  quotaMax: num(env.SUBMIT_QUOTA_MAX, 10),
  quotaWindow: num(env.SUBMIT_QUOTA_WINDOW_S, 86400),
};
const nowS = () => Math.floor(Date.now() / 1000);

export const limitRow = (key) => {
  const r = db.prepare("SELECT count,expires_at FROM request_limits WHERE key=?").get(key);
  return r && r.expires_at > nowS() ? r : null;
};
export const hit = (key, windowS) => {
  const t = nowS();
  db.prepare(
    "INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END",
  ).run(key, t + windowS, t, t, t + windowS);
};
export const retryAfter = (r) => String(Math.max(1, r.expires_at - nowS()));

const cleanupLimits = () => {
  try {
    db.prepare("DELETE FROM request_limits WHERE expires_at<?").run(nowS());
  } catch (e) {
    log.error("limit_cleanup_failed", errFields(e));
  }
};
// Removes expired rows now and every 10 minutes.
export const startLimitCleanup = () => {
  cleanupLimits();
  setInterval(cleanupLimits, 600_000).unref();
};

export const submitAbuseLimit = (req, res, next) => {
  const key = "abuse:" + sha(req.ip || "unknown");
  const r = limitRow(key);
  if (r && r.count >= LIMITS.abuseMax) {
    res.set("Retry-After", retryAfter(r));
    return error(res, "For mange forsøk. Vent noen minutter og prøv igjen.", 429);
  }
  hit(key, LIMITS.abuseWindow);
  next();
};
