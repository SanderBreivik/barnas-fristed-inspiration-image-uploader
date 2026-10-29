import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const dir = mkdtempSync(path.join(tmpdir(), "bf-video-"));
const PW = "a".repeat(24);
Object.assign(process.env, {
  NODE_ENV: "test",
  DATA_DIR: dir,
  PUBLIC_ORIGIN: "https://backend.test",
  SHOP_ORIGIN: "https://barnasfristed.no",
  TURNSTILE_SITE_KEY: "x",
  TURNSTILE_SECRET: "x",
  ADMIN_PASSWORD: PW,
  AWS_ENDPOINT_URL_S3: "http://localhost:1",
  BUCKET_NAME: "b",
  AWS_ACCESS_KEY_ID: "k",
  AWS_SECRET_ACCESS_KEY: "s",
  SUBMIT_QUOTA_MAX: "50",
  SUBMIT_ABUSE_MAX: "100",
  VIDEO_TARGET_MB: "0.01", // 10 485 bytes, so tests can use tiny "videos"
  VIDEO_MAX_UPLOAD_MB: "0.05", // 52 428 bytes
});
const { app, db, storage } = await import("../server/index.js");
const { tools, idle, incomingDir, incomingPath, sniff, LADDER } = await import("../server/video.js");

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) =>
  String(url).includes("challenges.cloudflare.com")
    ? Promise.resolve(Response.json({ success: true, hostname: "barnasfristed.no" }))
    : realFetch(url, opts);

// ffprobe/ffmpeg are replaced so the tests do not need them installed.
let inputProbe, sizeForCrf, gate;
const ffmpegCrfs = [];
const encodeCalls = [];
let poster;
tools.run = async (cmd, args) => {
  const last = args.at(-1);
  if (cmd === "ffprobe")
    return JSON.stringify(
      last.endsWith(".upload")
        ? inputProbe
        : { format: { duration: "9.8" }, streams: [{ codec_type: "video", width: 1280, height: 720 }] },
    );
  if (args.includes("-frames:v")) {
    writeFileSync(last, poster);
    return "";
  }
  const crf = Number(args[args.indexOf("-crf") + 1]);
  ffmpegCrfs.push(crf);
  encodeCalls.push(args);
  if (gate) await gate;
  writeFileSync(last, Buffer.alloc(sizeForCrf(crf), 1));
  return "";
};
const probeOf = (duration, w = 1920, h = 1080) => ({
  format: { duration: String(duration) },
  streams: [{ codec_type: "video", width: w, height: h }],
});

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(200)]);
let server, base, version;
const puts = new Map();
const deleted = [];
before(async () => {
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  storage.put = async (k, b) => void puts.set(k, b);
  storage.get = async (k) => puts.get(k);
  storage.del = async (k) => void deleted.push(k);
  storage.list = async (prefix) => [...puts.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
  version = (await (await realFetch(`${base}/api/consent`)).json()).version;
  poster = await sharp({ create: { width: 64, height: 36, channels: 3, background: "#38c" } }).jpeg().toBuffer();
});
after(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const reset = () => {
  inputProbe = probeOf(10);
  sizeForCrf = () => 5000;
  gate = null;
  ffmpegCrfs.length = 0;
  encodeCalls.length = 0;
};

function submit(file = mp4, audio) {
  const f = new FormData();
  f.set("video", new Blob([file]), "clip.mp4");
  if (audio !== undefined) f.set("includeAudio", String(audio));
  f.set("galleryConsent", "true");
  f.set("marketingConsent", "false");
  f.set("consentVersion", version);
  f.set("turnstileToken", "tok");
  return realFetch(`${base}/api/submit-video`, {
    method: "POST",
    headers: { Origin: "https://barnasfristed.no" },
    body: f,
  });
}
const row = (id) => db.prepare("SELECT * FROM photos WHERE id=?").get(id);
const uploads = () => readdirSync(incomingDir).filter((n) => n.endsWith(".upload"));

async function adminSession() {
  const r = await realFetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://backend.test" },
    body: JSON.stringify({ password: PW }),
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const { csrf } = await r.json();
  return (p, method = "GET") =>
    realFetch(`${base}${p}`, { method, headers: { Cookie: cookie, "X-CSRF-Token": csrf, Origin: "https://backend.test" } });
}

test("sniff recognises mp4/mov and webm and nothing else", () => {
  assert.equal(sniff(mp4), "mov");
  assert.equal(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), "matroska");
  assert.equal(sniff(Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n")), null);
  assert.equal(sniff(Buffer.from("not a video at all")), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
});

test("valid video: 201 right away, compressed in the background, then ready", async () => {
  reset();
  const r = await submit();
  assert.equal(r.status, 201);
  const { id, removalToken } = await r.json();
  assert.ok(removalToken);
  assert.equal(row(id).media_type, "video");
  await idle();
  const ready = row(id);
  assert.equal(ready.media_status, "ready");
  assert.equal(ready.status, "pending");
  assert.deepEqual([ready.width, ready.height, ready.duration_ms], [1280, 720, 9800]);
  assert.ok(puts.has(`photos/${id}.mp4`));
  assert.equal(uploads().length, 0, "upload file removed after processing");
  assert.equal(
    db.prepare("SELECT count(*) c FROM consent_events WHERE photo_id=? AND action='submitted'").get(id).c,
    1,
  );
});

test("too large output is compressed again with stronger settings until it fits", async () => {
  reset();
  const crfs = LADDER.map((l) => l.crf);
  sizeForCrf = (crf) => ({ [crfs[0]]: 30000, [crfs[1]]: 20000, [crfs[2]]: 9000 })[crf] ?? 5000;
  const { id } = await (await submit()).json();
  await idle();
  assert.deepEqual(ffmpegCrfs, crfs.slice(0, 3));
  assert.equal(row(id).media_status, "ready");
  assert.equal(puts.get(`photos/${id}.mp4`).length, 9000);
});

test("sound is removed unless the customer chose to keep it", async () => {
  reset();
  const silent = await (await submit()).json();
  await idle();
  assert.ok(encodeCalls.at(-1).includes("-an"));
  assert.ok(!encodeCalls.at(-1).includes("-c:a"));
  assert.equal(row(silent.id).keep_audio, 0);

  reset();
  const loud = await (await submit(mp4, true)).json();
  await idle();
  assert.ok(!encodeCalls.at(-1).includes("-an"));
  assert.ok(encodeCalls.at(-1).includes("-c:a"));
  assert.equal(row(loud.id).keep_audio, 1);
});

test("a result between one and two times the target is accepted", async () => {
  reset();
  sizeForCrf = () => 15000;
  const { id } = await (await submit()).json();
  await idle();
  assert.equal(ffmpegCrfs.length, LADDER.length);
  assert.equal(row(id).media_status, "ready");
});

test("a result more than twice the target fails and is never stored", async () => {
  reset();
  sizeForCrf = () => 25000;
  const { id } = await (await submit()).json();
  await idle();
  assert.equal(row(id).media_status, "failed");
  assert.ok(!puts.has(`photos/${id}.mp4`));
  assert.equal(uploads().length, 0);
});

test("videos that are too long, not videos, or have no video stream are refused", async () => {
  reset();
  const before = db.prepare("SELECT count(*) c FROM photos").get().c;
  inputProbe = probeOf(40);
  let r = await submit();
  assert.equal(r.status, 400);
  const tooLong = await r.json();
  assert.match(tooLong.error, /for lang/);
  assert.equal(tooLong.field, "file");

  reset();
  r = await submit(Buffer.from("#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n"));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Ugyldig videoformat/);

  reset();
  inputProbe = { format: { duration: "5" }, streams: [{ codec_type: "audio" }] };
  assert.equal((await submit()).status, 400);

  assert.equal(db.prepare("SELECT count(*) c FROM photos").get().c, before);
  assert.equal(uploads().length, 0, "refused uploads are deleted");
  assert.equal(ffmpegCrfs.length, 0, "nothing was compressed");
});

test("uploads above the size limit get 413", async () => {
  reset();
  const r = await submit(Buffer.concat([mp4, Buffer.alloc(60_000)]));
  assert.equal(r.status, 413);
  const tooBig = await r.json();
  assert.match(tooBig.error, /for stor/);
  assert.equal(tooBig.field, "file");
  assert.equal(uploads().length, 0);
});

test("video cannot be approved while processing, and is not public until approved", async () => {
  reset();
  const api = await adminSession();
  db.prepare(
    "INSERT INTO photos(id,object_key,status,gallery_consent,consent_version,consent_text,submitted_at,removal_token_hash,media_type,media_status) VALUES('vp','photos/vp.mp4','pending',1,'v','t','now','h','video','processing')",
  ).run();
  assert.equal((await api("/api/admin/photos/vp/approve", "POST")).status, 409);
  assert.equal(row("vp").status, "pending");

  const { id } = await (await submit()).json();
  await idle();
  assert.equal((await realFetch(`${base}/videos/${id}`)).status, 404);
  const g = await (await realFetch(`${base}/api/gallery`)).json();
  assert.ok(!g.photos.some((p) => p.id === id));
  // Admin can watch it before approving.
  const adminVideo = await api(`/api/admin/video/${id}`);
  assert.equal(adminVideo.status, 200);
  await adminVideo.arrayBuffer();
  assert.equal((await api(`/api/admin/preview/${id}`)).status, 200);
});

test("approved video: gallery entry, poster, and ranged playback", async () => {
  reset();
  const api = await adminSession();
  const { id } = await (await submit()).json();
  await idle();
  assert.equal((await api(`/api/admin/photos/${id}/approve`, "POST")).status, 200);

  const g = await (await realFetch(`${base}/api/gallery`)).json();
  const p = g.photos.find((x) => x.id === id);
  assert.equal(p.type, "video");
  assert.equal(p.videoUrl, `https://backend.test/videos/${id}`);
  assert.equal(p.thumbUrl, `https://backend.test/images/${id}/thumb`);
  assert.equal(p.imageUrl, p.thumbUrl);
  assert.equal(p.durationMs, 9800);

  const poster = await realFetch(`${base}/images/${id}/thumb`);
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get("content-type"), "image/webp");
  await poster.arrayBuffer();
  assert.equal((await realFetch(`${base}/images/${id}`)).status, 404, "no full image for a video");

  const full = await realFetch(`${base}/videos/${id}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("cross-origin-resource-policy"), "cross-origin");
  await full.arrayBuffer();
  const part = await realFetch(`${base}/videos/${id}`, { headers: { Range: "bytes=0-99" } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
});

test("removal while processing: nothing stays in storage and the row stays deleted", async () => {
  reset();
  let release;
  gate = new Promise((r) => (release = r));
  const { id, removalToken } = await (await submit()).json();
  const rm = await realFetch(`${base}/api/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://backend.test" },
    body: JSON.stringify({ id, token: removalToken }),
  });
  assert.equal(rm.status, 200);
  release();
  await idle();
  assert.equal(row(id).status, "deleted");
  assert.notEqual(row(id).media_status, "ready");
  assert.ok(deleted.includes(`photos/${id}.mp4`), "the finished upload was deleted again");
  assert.ok(!existsSync(incomingPath(id)));
});

test("remove page preview of a finished video is its poster", async () => {
  reset();
  const { id, removalToken } = await (await submit()).json();
  await idle();
  const r = await realFetch(`${base}/api/remove/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://backend.test" },
    body: JSON.stringify({ id, token: removalToken }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.equal(r.headers.get("x-photo-status"), "pending");
  await r.arrayBuffer();
});

test("remove page learns when a video is still processing or failed", async () => {
  const { createHash } = await import("node:crypto");
  for (const status of ["processing", "failed"]) {
    const id = `rv-${status}`;
    db.prepare(
      "INSERT INTO photos(id,object_key,status,gallery_consent,consent_version,consent_text,submitted_at,removal_token_hash,media_type,media_status) VALUES(?,?,'pending',1,'v','t','now',?,'video',?)",
    ).run(id, `photos/${id}.mp4`, createHash("sha256").update("tok").digest("hex"), status);
    const r = await realFetch(`${base}/api/remove/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://backend.test" },
      body: JSON.stringify({ id, token: "tok" }),
    });
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("x-media-status"), status);
    await r.arrayBuffer();
  }
});

test("reconcile ignores videos that are still processing", async () => {
  const { reconcile } = await import("../server/maintenance.js");
  const report = await reconcile({ db, storage });
  assert.ok(!report.missingObjects.includes("vp"));
});
