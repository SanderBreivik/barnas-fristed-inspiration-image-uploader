import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const dir = mkdtempSync(path.join(tmpdir(), "bf-"));
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
});
const { app, db, storage } = await import("../server/index.js");

let server, base;
const deleted = [];
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  storage.del = async (k) => { deleted.push(k); };
  storage.get = async () => Buffer.from("img");
});
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const sha = (s) => createHash("sha256").update(s).digest("hex");
let n = 0;
function seed(status = "approved") {
  const id = `id${++n}`, token = `token${n}`;
  db.prepare(
    "INSERT INTO photos(id,object_key,status,gallery_consent,consent_version,consent_text,submitted_at,removal_token_hash) VALUES(?,?,?,1,'v','t','now',?)",
  ).run(id, `photos/${id}.webp`, status, sha(token));
  return { id, token };
}
const remove = (body, origin = "https://backend.test") =>
  fetch(`${base}/api/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });

test("valid token removes image, logs withdrawal, hides from public", async () => {
  const { id, token } = seed();
  assert.equal((await fetch(`${base}/images/${id}`)).status, 200);
  const r = await remove({ id, token });
  assert.equal(r.status, 200);
  assert.ok(deleted.includes(`photos/${id}.webp`));
  assert.equal((await fetch(`${base}/images/${id}`)).status, 404);
  const g = await (await fetch(`${base}/api/gallery`)).json();
  assert.ok(!g.photos.some((p) => p.id === id));
  assert.equal(
    db.prepare("SELECT count(*) c FROM consent_events WHERE photo_id=? AND action='withdrawn'").get(id).c,
    1,
  );
});

test("storefront origin may also remove", async () => {
  const { id, token } = seed();
  assert.equal((await remove({ id, token }, "https://barnasfristed.no")).status, 200);
});

test("invalid token / unknown id / bad origin rejected", async () => {
  const { id } = seed();
  assert.equal((await remove({ id, token: "wrong" })).status, 403);
  assert.equal((await remove({ id: "nope", token: "x" })).status, 403);
  assert.equal((await remove({ id })).status, 403);
  assert.equal((await remove({ id, token: "wrong" }, "https://evil.test")).status, 403);
  assert.equal(db.prepare("SELECT status FROM photos WHERE id=?").get(id).status, "approved");
});

test("repeat removal is idempotent and logs withdrawal once", async () => {
  const { id, token } = seed();
  assert.equal((await remove({ id, token })).status, 200);
  const r = await remove({ id, token });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).alreadyRemoved, true);
  assert.equal(
    db.prepare("SELECT count(*) c FROM consent_events WHERE photo_id=?").get(id).c,
    1,
  );
});

test("storage failure: unpublished, 202, retry completes", async () => {
  const { id, token } = seed();
  const orig = storage.del;
  storage.del = async () => { throw new Error("tigris down"); };
  const r = await remove({ id, token });
  assert.equal(r.status, 202);
  assert.equal((await fetch(`${base}/images/${id}`)).status, 404);
  assert.equal(db.prepare("SELECT storage_deleted_at s FROM photos WHERE id=?").get(id).s, null);
  storage.del = orig;
  assert.equal((await remove({ id, token })).status, 200);
  assert.ok(db.prepare("SELECT storage_deleted_at s FROM photos WHERE id=?").get(id).s);
  assert.equal(
    db.prepare("SELECT count(*) c FROM consent_events WHERE photo_id=?").get(id).c,
    1,
  );
});

test("admin cannot re-approve a deleted photo", async () => {
  const { id, token } = seed();
  await remove({ id, token });
  const login = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://backend.test" },
    body: JSON.stringify({ password: "a".repeat(24) }),
  });
  const { csrf } = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const r = await fetch(`${base}/api/admin/photos/${id}/approve`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": csrf },
  });
  assert.equal(r.status, 409);
});

const preview = (body, origin = "https://backend.test") =>
  fetch(`${base}/api/remove/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });

test("removal preview works for pending photo with valid token only", async () => {
  const { id, token } = seed("pending");
  const ok = await preview({ id, token });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-photo-status"), "pending");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal((await preview({ id, token: "wrong" })).status, 403);
  assert.equal((await preview({ id, token }, "https://evil.test")).status, 403);
  assert.equal((await fetch(`${base}/images/${id}`)).status, 404); // still not public
});

test("removal preview is gone after removal", async () => {
  const { id, token } = seed();
  await remove({ id, token });
  assert.equal((await preview({ id, token })).status, 410);
});
