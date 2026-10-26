// Operational monitoring helpers: alert webhook, crash detection, memory.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Sends a short text message to a webhook (Slack, Discord, ntfy, Teams-style
// "text"/"content" JSON). Throttled per event so an outage cannot spam you.
// Only the event name and error message are sent, never request data.
export function createAlerter({
  url,
  throttleMs = 15 * 60_000,
  fetchFn = (...a) => globalThis.fetch(...a),
  now = Date.now,
  source = "barnas-fristed",
} = {}) {
  const last = new Map();
  return (event, entry = {}) => {
    if (!url) return;
    const t = now();
    if (t - (last.get(event) ?? -Infinity) < throttleMs) return;
    last.set(event, t);
    const text = `[${source}] ${event}${entry.message ? `: ${entry.message}` : ""}`;
    Promise.resolve(
      fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text }),
      }),
    ).catch(() => {});
  };
}

// Crash / OOM detection without extra infrastructure: a marker file on the
// volume exists while the process runs and is removed on clean shutdown
// (deploys and `fly machine restart` send SIGINT/SIGTERM). If it is still there
// at startup, the previous run ended abruptly (OOM kill, crash, power loss).
const marker = (dir) => path.join(dir, ".running");
export function checkUncleanShutdown(dir) {
  const file = marker(dir);
  let previousStart = null;
  const unclean = existsSync(file);
  if (unclean) {
    try {
      previousStart = JSON.parse(readFileSync(file, "utf8")).startedAt ?? null;
    } catch {
      /* ignore unreadable marker */
    }
  }
  writeFileSync(file, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }));
  return { unclean, previousStart };
}
export function markCleanShutdown(dir) {
  rmSync(marker(dir), { force: true });
}

export function memorySnapshot(limitMb) {
  const m = process.memoryUsage();
  const limit = (limitMb || os.totalmem() / 1048576) * 1048576;
  return {
    rssMb: Math.round(m.rss / 1048576),
    heapMb: Math.round(m.heapUsed / 1048576),
    limitMb: Math.round(limit / 1048576),
    ratio: m.rss / limit,
  };
}
