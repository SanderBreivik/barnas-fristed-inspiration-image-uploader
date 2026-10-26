import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { log, sanitize } from "../server/log.js";

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
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("log lines are JSON and secrets are redacted", () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    log.info("test_event", {
      password: "hunter2",
      removalToken: "abc",
      authorization: "Bearer x",
      cookie: "sid=1",
      imageBuffer: "xxx",
      note: "y".repeat(1000),
    });
  } finally {
    console.log = orig;
  }
  const e = JSON.parse(lines[0]);
  assert.equal(e.event, "test_event");
  for (const k of ["password", "removalToken", "authorization", "cookie", "imageBuffer"])
    assert.equal(e[k], "[redacted]");
  assert.ok(e.note.length <= 301);
  assert.ok(!lines[0].includes("hunter2"));
  assert.deepEqual(sanitize({ nested: { a: 1 } }), { nested: "[object]" });
});

test("/health stays shallow; /health/deep reflects dependencies", async () => {
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
  storage.list = async () => [];
  let r = await fetch(`${base}/health/deep`);
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 10)); // let the 1 ms cache expire
  storage.list = async () => {
    throw new Error("tigris down");
  };
  r = await fetch(`${base}/health/deep`);
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.storage, false);
  assert.ok(!JSON.stringify(body).includes("tigris"));
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
