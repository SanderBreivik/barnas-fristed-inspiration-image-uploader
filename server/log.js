// Structured JSON logging (one line per event, easy to filter in `fly logs`).
// Sensitive field names are always redacted and long strings truncated, so
// passwords, tokens and image data can never end up in the logs.
const SENSITIVE = /token|password|secret|authorization|cookie|credential|body|buffer/i;
const MAX_LEN = 300;

// Events that should notify the operator (via the alert sink, if configured).
export const ALERT_EVENTS = new Set([
  "unclean_restart",
  "memory_high",
  "health_check_failed",
  "backup_failed",
  "storage_delete_failed",
  "storage_put_failed",
  "orphan_object",
  "submit_failed",
  "db_error",
  "uncaught_exception",
  "unhandled_rejection",
]);

let alertSink = null;
export const setAlertSink = (fn) => {
  alertSink = typeof fn === "function" ? fn : null;
};

const counts = new Map();
// Returns event counts since the last call (used for periodic metrics lines).
export const drainCounts = () => {
  const out = Object.fromEntries(counts);
  counts.clear();
  return out;
};

export function sanitize(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SENSITIVE.test(k)) out[k] = "[redacted]";
    else if (typeof v === "string") out[k] = v.length > MAX_LEN ? v.slice(0, MAX_LEN) + "…" : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else out[k] = "[object]";
  }
  return out;
}

export const errFields = (e) => ({
  message: String(e?.message ?? e ?? "unknown error"),
  code: e?.code ?? e?.$metadata?.httpStatusCode,
  errorName: e?.name,
});

function emit(level, event, fields = {}) {
  const { alert, ...rest } = fields;
  const entry = { time: new Date().toISOString(), level, event, ...sanitize(rest) };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "fatal") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  counts.set(event, (counts.get(event) || 0) + 1);
  if (alertSink && (alert === true || ALERT_EVENTS.has(event))) {
    try {
      alertSink(event, entry);
    } catch {
      /* alerting must never break the app */
    }
  }
}

export const log = {
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
  fatal: (event, fields) => emit("fatal", event, fields),
};
