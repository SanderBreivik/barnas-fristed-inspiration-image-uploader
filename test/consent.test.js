import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "bf-consent-"));
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
delete process.env.CONSENT_VERSION;
const { app, db } = await import("../server/index.js");
let server, base;
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

test("consent texts are served separately and marketing is optional", async () => {
  const d = await (await fetch(`${base}/api/consent`)).json();
  assert.ok(d.version && d.galleryText && d.marketingText);
  assert.match(d.marketingText, /Valgfritt/);
  assert.ok(!d.galleryText.includes(d.marketingText));
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.consentVersion, d.version);
});
