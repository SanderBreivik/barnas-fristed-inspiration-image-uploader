import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const dir = mkdtempSync(path.join(tmpdir(), "bf-upload-"));
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
  SUBMIT_ABUSE_MAX: "8",
  SUBMIT_QUOTA_MAX: "2",
});
const { app, db, storage } = await import("../server/index.js");

// Stub Cloudflare Siteverify; everything else uses the real fetch.
const realFetch = globalThis.fetch;
let turnstileOk = true;
globalThis.fetch = (url, opts) =>
  String(url).includes("challenges.cloudflare.com")
    ? Promise.resolve(
        Response.json(
          turnstileOk ? { success: true, hostname: "barnasfristed.no" } : { success: false },
        ),
      )
    : realFetch(url, opts);

let server, base, version, png;
const puts = [];
let failPut = false;
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  storage.put = async (k) => {
    if (failPut) throw new Error("tigris down");
    puts.push(k);
  };
  storage.del = async () => {};
  version = (await (await realFetch(`${base}/api/consent`)).json()).version;
  png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();
});
after(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const quotaCount = () =>
  db.prepare("SELECT COALESCE(SUM(count),0) c FROM request_limits WHERE key LIKE 'quota:%'").get().c;
const photoCount = () => db.prepare("SELECT count(*) c FROM photos").get().c;

function submit({ file = png, marketing = false, consent = "true" } = {}) {
  const f = new FormData();
  f.set("image", new Blob([file]), "photo.webp");
  f.set("galleryConsent", consent);
  f.set("marketingConsent", String(marketing));
  f.set("consentVersion", version);
  f.set("turnstileToken", "tok");
  f.set("displayName", "Test");
  return realFetch(`${base}/api/submit`, {
    method: "POST",
    headers: { Origin: "https://barnasfristed.no" },
    body: f,
  });
}

test("valid upload: 201, pending record, consent recorded, quota used", async () => {
  const r = await submit({ marketing: false });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok(body.id && body.removalToken);
  const row = db.prepare("SELECT status,gallery_consent,marketing_consent,consent_version FROM photos WHERE id=?").get(body.id);
  assert.deepEqual({ ...row }, { status: "pending", gallery_consent: 1, marketing_consent: 0, consent_version: version });
  const ev = db.prepare("SELECT action,marketing_consent FROM consent_events WHERE photo_id=?").get(body.id);
  assert.deepEqual({ ...ev }, { action: "submitted", marketing_consent: 0 });
  assert.equal(quotaCount(), 1);
});

test("invalid file is rejected and does not use the quota", async () => {
  const before = photoCount();
  const r = await submit({ file: Buffer.from("not an image") });
  assert.equal(r.status, 400);
  assert.equal(quotaCount(), 1);
  assert.equal(photoCount(), before);
});

test("turnstile failure is rejected and does not use the quota", async () => {
  turnstileOk = false;
  const r = await submit();
  turnstileOk = true;
  assert.equal(r.status, 403);
  assert.equal(quotaCount(), 1);
});

test("missing gallery consent is rejected", async () => {
  // counts as an attempt (abuse limit) but not as an upload (quota)
  const r = await submit({ consent: "false" });
  assert.equal(r.status, 400);
  assert.equal(quotaCount(), 1);
});

test("storage failure returns 502, stores nothing, keeps quota", async () => {
  failPut = true;
  const before = photoCount();
  const r = await submit();
  failPut = false;
  assert.equal(r.status, 502);
  assert.equal(photoCount(), before);
  assert.equal(quotaCount(), 1);
});

test("second valid upload still works; third hits the success quota", async () => {
  assert.equal((await submit({ marketing: true })).status, 201);
  assert.equal(quotaCount(), 2);
  const r = await submit();
  assert.equal(r.status, 429);
  assert.ok(r.headers.get("retry-after"));
  assert.match((await r.json()).error, /mange bilder/);
  assert.equal(puts.length, 2); // nothing stored for the rejected one
});

test("repeated attempts hit the anti-abuse limit", async () => {
  let blocked = false;
  for (let i = 0; i < 6 && !blocked; i++) {
    const r = await submit();
    blocked = r.status === 429 && /For mange forsøk/.test((await r.json()).error);
  }
  assert.ok(blocked);
});
