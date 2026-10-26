import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const dir = mkdtempSync(path.join(tmpdir(), "bf-auth-"));
const PW = "a".repeat(24);
Object.assign(process.env, {
  NODE_ENV: "test",
  DATA_DIR: dir,
  PUBLIC_ORIGIN: "https://backend.test",
  SHOP_ORIGIN: "https://barnasfristed.no",
  TURNSTILE_SITE_KEY: "x",
  TURNSTILE_SECRET: "x",
  ADMIN_PASSWORD: PW,
  ADMIN_LOGIN_MAX_FAILS: "3",
  AWS_ENDPOINT_URL_S3: "http://localhost:1",
  BUCKET_NAME: "b",
  AWS_ACCESS_KEY_ID: "k",
  AWS_SECRET_ACCESS_KEY: "s",
});
const { app, db, storage } = await import("../server/index.js");
let server, base;
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  storage.get = async () => Buffer.from("img");
  storage.del = async () => {};
  db.prepare(
    "INSERT INTO photos(id,object_key,status,gallery_consent,consent_version,consent_text,submitted_at,removal_token_hash) VALUES('p1','photos/p1.webp','pending',1,'v','t','now','x')",
  ).run();
});
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const ORIGIN = "https://backend.test";
const login = (password, origin = ORIGIN) =>
  fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ password }),
  });

test("private endpoints reject anonymous and Bearer-only requests", async () => {
  for (const p of ["/api/admin/photos", "/api/admin/preview/p1"]) {
    assert.equal((await fetch(base + p)).status, 401);
    assert.equal((await fetch(base + p, { headers: { Authorization: `Bearer ${PW}` } })).status, 401);
  }
  assert.equal((await fetch(`${base}/images/p1`)).status, 404); // pending is not public
});

test("session cookie is HttpOnly/Secure/SameSite and password never echoed", async () => {
  const r = await login(PW);
  assert.equal(r.status, 200);
  const sc = r.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Strict/);
  assert.ok(!JSON.stringify(await r.json()).includes(PW));
});

test("login requires same origin", async () => {
  assert.equal((await login(PW, "https://evil.test")).status, 403);
  assert.equal((await login(PW, null)).status, 403);
});

test("session works for GET; mutations need CSRF token; logout ends session", async () => {
  const r = await login(PW);
  const { csrf } = await r.json();
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${base}/api/admin/photos`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/preview/p1`, { headers: { Cookie: cookie } })).status, 200);
  const act = (h) => fetch(`${base}/api/admin/photos/p1/approve`, { method: "POST", headers: h });
  assert.equal((await act({ Cookie: cookie })).status, 403);
  assert.equal((await act({ Cookie: cookie, "X-CSRF-Token": "bad" })).status, 403);
  assert.equal((await act({ Cookie: cookie, "X-CSRF-Token": csrf })).status, 200);
  const out = await fetch(`${base}/api/admin/logout`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": csrf, Origin: ORIGIN },
  });
  assert.equal(out.status, 200);
  assert.equal((await fetch(`${base}/api/admin/photos`, { headers: { Cookie: cookie } })).status, 401);
});

test("brute force is rate limited (runs last)", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await login("wrong")).status, 401);
  const r = await login("wrong");
  assert.equal(r.status, 429);
  assert.ok(r.headers.get("retry-after"));
  assert.equal((await login(PW)).status, 429); // even the right password is blocked
});
