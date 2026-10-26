// Minimal structured logging: one JSON line per event, readable with `fly logs`.
// Sensitive field names are always redacted and long strings truncated, so
// passwords, tokens and image data can never end up in the logs.
const SENSITIVE = /token|password|secret|authorization|cookie|credential|body|buffer/i;
const MAX_LEN = 300;

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

function emit(level, event, fields) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...sanitize(fields) });
  if (level === "error" || level === "fatal") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
  fatal: (event, fields) => emit("fatal", event, fields),
};
