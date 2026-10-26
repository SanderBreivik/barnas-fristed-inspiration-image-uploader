import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "bf-cors-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  DATA_DIR: dir,
  PUBLIC_ORIGIN: "https://backend.test",
  SHOP_ORIGIN: "https://barnasfristed.no",
  EXTRA_ORIGINS: " https://extra.example.com/ ,",
  TURNSTILE_SITE_KEY: "x",
  TURNSTILE_SECRET: "x",
  ADMIN_PASSWORD: "a".repeat(24),
  AWS_ENDPOINT_URL_S3: "http://localhost:1",
  BUCKET_NAME: "b",
  AWS_ACCESS_KEY_ID: "k",
  AWS_SECRET_ACCESS_KEY: "s",
});
const { app, db } = await import("../server/index.js");

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

const acao = async (origin, method = "GET") => {
  const r = await fetch(`${base}/api/config`, { method, headers: origin ? { Origin: origin } : {} });
  return r.headers.get("access-control-allow-origin");
};

test("storefront origins get CORS headers", async () => {
  for (const o of [
    "https://barnasfristed.no",
    "https://www.barnasfristed.no",
    "https://barnas-fristed.myshopify.com",
  ])
    assert.equal(await acao(o), o);
});

test("Shopify preview hosts are allowed, lookalikes are rejected", async () => {
  assert.equal(await acao("https://random-123.shopifypreview.com"), "https://random-123.shopifypreview.com");
  for (const o of [
    "https://shopifypreview.com.evil.com",
    "https://evilshopifypreview.com",
    "http://random.shopifypreview.com",
    "https://random.shopifypreview.com:8443",
    "https://a.b.shopifypreview.com",
    "https://barnasfristed.no.evil.com",
    "http://barnasfristed.no",
    "https://barnasfristed.no:8443",
    "https://evil.com",
    "null",
  ])
    assert.equal(await acao(o), null, o);
  assert.equal(await acao(undefined), null);
});

test("EXTRA_ORIGINS adds exact origins only (trimmed, no trailing slash)", async () => {
  assert.equal(await acao("https://extra.example.com"), "https://extra.example.com");
  assert.equal(await acao("https://other.example.com"), null);
});

test("preflight: allowed origin gets headers without Authorization; others get none", async () => {
  const ok = await fetch(`${base}/api/submit`, { method: "OPTIONS", headers: { Origin: "https://barnasfristed.no" } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-headers"), "Content-Type");
  const bad = await fetch(`${base}/api/submit`, { method: "OPTIONS", headers: { Origin: "https://evil.com" } });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  assert.equal(bad.headers.get("access-control-allow-methods"), null);
});

test("submit from a non-allowlisted origin is refused", async () => {
  const r = await fetch(`${base}/api/submit`, { method: "POST", headers: { Origin: "https://evil.com" } });
  assert.equal(r.status, 403);
});
