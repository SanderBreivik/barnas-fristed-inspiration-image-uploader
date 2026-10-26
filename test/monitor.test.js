import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { log, sanitize, setAlertSink, drainCounts } from "../server/log.js";
import {
  createAlerter,
  checkUncleanShutdown,
  markCleanShutdown,
  memorySnapshot,
} from "../server/monitor.js";

const dir = mkdtempSync(path.join(tmpdir(), "bf-mon-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  DATA_DIR: dir,
  PUBLIC_ORIGIN: "https://backend.test",
  SHOP_ORIGIN: "https://barnasfristed.no",
  TURNSTILE_SITE_KEY: "x",
  TURNSTILE_SECRET: "x",
  ADMIN_PASSWORD: "a".repeat(24),
  AWS_ENDPOINT_URL_S3: "http://localhost:1",
  BUCKET_NAME: "b",
  AWS_ACCESS_KEY_ID: "k",
  AWS_SECRET_ACCESS_KEY: "s",
  HEALTH_CACHE_MS: "1",
});
const { app, db, storage } = await import("../server/index.js");

let server, base;
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  setAlertSink(null);
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function capture(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (l) => lines.push(l);
  try {
    fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

test("log lines are JSON and secrets are redacted", () => {
  const [line] = capture(() =>
    log.info("test_event", {
      password: "hunter2",
      removalToken: "abc",
      authorization: "Bearer x",
      cookie: "sid=1",
      imageBuffer: "xxx",
      ok: true,
      note: "y".repeat(1000),
    }),
  );
  const e = JSON.parse(line);
  assert.equal(e.event, "test_event");
  assert.equal(e.level, "info");
  assert.equal(e.password, "[redacted]");
  assert.equal(e.removalToken, "[redacted]");
  assert.equal(e.authorization, "[redacted]");
  assert.equal(e.cookie, "[redacted]");
  assert.equal(e.imageBuffer, "[redacted]");
  assert.ok(e.note.length <= 301);
  assert.ok(!line.includes("hunter2"));
  assert.deepEqual(sanitize({ nested: { a: 1 } }), { nested: "[object]" });
});

test("alert events reach the sink; ordinary events do not", () => {
  const seen = [];
  setAlertSink((event) => seen.push(event));
  capture(() => {
    log.info("request", { path: "/x" });
    log.error("backup_failed", { message: "boom" });
    log.warn("custom", { alert: true });
  });
  setAlertSink(null);
  assert.deepEqual(seen, ["backup_failed", "custom"]);
});

test("alerter throttles per event and sends only safe text", async () => {
  const calls = [];
  let t = 0;
  const alert = createAlerter({
    url: "https://hooks.test/x",
    throttleMs: 1000,
    now: () => t,
    fetchFn: async (url, opts) => void calls.push({ url, body: JSON.parse(opts.body) }),
  });
  alert("backup_failed", { message: "tigris down", password: "no" });
  alert("backup_failed", { message: "again" }); // throttled
  alert("memory_high", { message: "rss" }); // different event
  t = 2000;
  alert("backup_failed", { message: "later" });
  assert.equal(calls.length, 3);
  assert.match(calls[0].body.text, /backup_failed: tigris down/);
  assert.ok(!JSON.stringify(calls[0].body).includes("password"));
  createAlerter({ url: "", fetchFn: () => assert.fail("must not send") })("x", {});
});

test("an alerter whose webhook fails never throws", () => {
  const alert = createAlerter({ url: "https://hooks.test/x", fetchFn: () => Promise.reject(new Error("net")) });
  assert.doesNotThrow(() => alert("backup_failed", {}));
});

test("unclean shutdown (crash/OOM) is detected on next start", () => {
  const d = mkdtempSync(path.join(tmpdir(), "bf-marker-"));
  try {
    assert.equal(checkUncleanShutdown(d).unclean, false); // first start
    const crashed = checkUncleanShutdown(d); // previous run never cleaned up
    assert.equal(crashed.unclean, true);
    assert.ok(crashed.previousStart);
    markCleanShutdown(d);
    assert.equal(existsSync(path.join(d, ".running")), false);
    assert.equal(checkUncleanShutdown(d).unclean, false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("memory snapshot reports a sane ratio", () => {
  const m = memorySnapshot(1024);
  assert.equal(m.limitMb, 1024);
  assert.ok(m.rssMb > 0 && m.ratio > 0 && m.ratio < 1);
});

test("/health stays shallow; /health/deep reflects dependencies", async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
  storage.list = async () => [];
  let r = await fetch(`${base}/health/deep`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { db: true, storage: true, ok: true });
  await new Promise((res) => setTimeout(res, 10)); // let the 1 ms cache expire
  storage.list = async () => {
    throw new Error("tigris down");
  };
  r = await fetch(`${base}/health/deep`);
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.storage, false);
  assert.ok(!JSON.stringify(body).includes("tigris")); // no internals leaked
});

test("malformed JSON gets a clean 400, not a 500 or stack trace", async () => {
  const r = await fetch(`${base}/api/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://backend.test" },
    body: "{not json",
  });
  assert.equal(r.status, 400);
  const text = await r.text();
  assert.ok(!text.includes("SyntaxError") && !text.includes(" at "));
});

test("event counters drain for metrics", () => {
  drainCounts();
  capture(() => {
    log.warn("turnstile_failed");
    log.warn("turnstile_failed");
  });
  assert.equal(drainCounts().turnstile_failed, 2);
  assert.deepEqual(drainCounts(), {});
});
