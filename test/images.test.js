import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const dir = mkdtempSync(path.join(tmpdir(), "bf-img-"));
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
const { sweepThumbs, removeThumb } = await import("../server/images.js");

let server, base, big;
let gets = 0;
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  big = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#c33" } })
    .webp()
    .toBuffer();
  storage.get = async () => {
    gets++;
    await new Promise((r) => setTimeout(r, 20));
    return big;
  };
});
after(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (id, status = "approved") =>
  db
    .prepare(
      "INSERT INTO photos(id,object_key,status,gallery_consent,consent_version,consent_text,submitted_at,approved_at,removal_token_hash) VALUES(?,?,?,1,'v','t','2026-01-01','2026-01-02','h')",
    )
    .run(id, `photos/${id}.webp`, status);
const thumbFile = (id) => path.join(dir, "thumbs", `${id}.webp`);

test("thumbnail is a smaller webp, cached on disk, and fills in image size", async () => {
  add("t1");
  const r = await fetch(`${base}/images/t1/thumb`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.equal(r.headers.get("cache-control"), "public, max-age=60");
  const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
  assert.equal(meta.width, 720);
  assert.equal(meta.height, 360);
  assert.ok(existsSync(thumbFile("t1")));
  const row = db.prepare("SELECT width,height FROM photos WHERE id='t1'").get();
  assert.deepEqual({ ...row }, { width: 2000, height: 1000 });
  const before = gets;
  await (await fetch(`${base}/images/t1/thumb`)).arrayBuffer();
  assert.equal(gets, before, "second request is served from the disk cache");
});

// fetch() adds "Cache-Control: no-cache" to conditional requests, which forces a
// full response; browsers revalidate without it, so use raw http here.
const conditional = (url, etag) =>
  new Promise((resolve, reject) => {
    http
      .get(url, { headers: { "If-None-Match": etag } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });

test("conditional request gets 304 without touching storage", async () => {
  const first = await fetch(`${base}/images/t1/thumb`);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  await first.arrayBuffer();
  const before = gets;
  assert.equal(await conditional(`${base}/images/t1/thumb`, etag), 304);
  const full = await fetch(`${base}/images/t1`);
  const fullTag = full.headers.get("etag");
  await full.arrayBuffer();
  assert.equal(await conditional(`${base}/images/t1`, fullTag), 304);
  assert.notEqual(etag, fullTag);
  assert.equal(gets, before + 1, "only the non-conditional full image hit storage");
});

test("concurrent requests for a new thumbnail share one storage read", async () => {
  add("t2");
  const before = gets;
  const rs = await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/images/t2/thumb`)));
  for (const r of rs) {
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  assert.equal(gets - before, 1);
});

test("unapproved or unknown photos have no image or thumbnail", async () => {
  add("p1", "pending");
  add("d1", "deleted");
  for (const id of ["p1", "d1", "nope"]) {
    assert.equal((await fetch(`${base}/images/${id}/thumb`)).status, 404);
    assert.equal((await fetch(`${base}/images/${id}`)).status, 404);
  }
});

test("gallery lists thumbUrl and dimensions", async () => {
  const g = await (await fetch(`${base}/api/gallery`)).json();
  const p = g.photos.find((x) => x.id === "t1");
  assert.equal(p.thumbUrl, "https://backend.test/images/t1/thumb");
  assert.equal(p.imageUrl, "https://backend.test/images/t1");
  assert.equal(p.width, 2000);
  assert.equal(p.height, 1000);
});

test("sweep removes cached thumbnails of photos that are no longer approved", async () => {
  add("t3");
  await (await fetch(`${base}/images/t3/thumb`)).arrayBuffer();
  assert.ok(existsSync(thumbFile("t3")));
  db.prepare("UPDATE photos SET status='deleted' WHERE id='t3'").run();
  assert.equal(sweepThumbs(), 1);
  assert.ok(!existsSync(thumbFile("t3")));
  assert.ok(existsSync(thumbFile("t1")), "approved photo keeps its thumbnail");
  removeThumb("t1");
  assert.ok(!existsSync(thumbFile("t1")));
});

test("storage failure gives a clean 500 and no cache file", async () => {
  add("t4");
  const orig = storage.get;
  storage.get = async () => {
    throw new Error("tigris down");
  };
  const r = await fetch(`${base}/images/t4/thumb`);
  storage.get = orig;
  assert.equal(r.status, 500);
  assert.ok(!(await r.text()).includes("tigris"));
  assert.ok(!existsSync(thumbFile("t4")));
});
