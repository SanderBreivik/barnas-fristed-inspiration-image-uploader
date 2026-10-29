// Video pipeline: validate the upload, compress it in the background with
// ffmpeg, store the result in Tigris and keep a re-creatable copy on the volume.
// Uploads are only ever read by ffmpeg through a forced demuxer (mov/matroska)
// and `-protocol_whitelist file`, so a crafted playlist cannot reach other files
// or hosts.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDir, env, num } from "./config.js";
import { db } from "./db.js";
import { storage } from "./storage.js";
import { log, errFields } from "./log.js";

const MB = 1024 * 1024;
export const VIDEO = {
  maxSeconds: num(env.VIDEO_MAX_SECONDS, 15),
  maxUploadBytes: Math.floor(num(env.VIDEO_MAX_UPLOAD_MB, 150) * MB),
  targetBytes: Math.floor(num(env.VIDEO_TARGET_MB, 8) * MB),
  queueMax: num(env.VIDEO_QUEUE_MAX, 4),
  jobTimeoutMs: num(env.VIDEO_JOB_TIMEOUT_S, 240) * 1000,
  maxPixels: 4096 * 4096,
};

export const incomingDir = path.resolve(dataDir, "video-incoming");
const cacheDir = path.resolve(dataDir, "videos");
mkdirSync(incomingDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
export const incomingPath = (id) => path.join(incomingDir, `${id}.upload`);
const cacheFile = (id) => path.join(cacheDir, `${id}.mp4`);

// Error whose message is safe to show to the customer.
export class VideoError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.userMessage = userMessage;
  }
}

// Replaceable in tests (ffmpeg is not installed everywhere).
function run(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => {
      if (out.length < 1_000_000) out += d;
    });
    p.stderr.on("data", (d) => {
      err = (err + d).slice(-2000);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(Object.assign(new Error(`${cmd} exited with ${code}`), { detail: err }));
    });
  });
}
export const tools = { run };

// Container type from the first bytes (never from the file name or MIME header).
export function sniff(b) {
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") return "mov";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return "matroska";
  return null;
}
function head(file) {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(16);
    const n = readSync(fd, b, 0, 16, 0);
    return b.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export async function probe(file, fmt) {
  const out = await tools.run(
    "ffprobe",
    ["-v", "error", "-protocol_whitelist", "file", "-f", fmt, "-print_format", "json", "-show_format", "-show_streams", file],
    20_000,
  );
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!v || !(v.width > 0) || !(v.height > 0)) throw new VideoError("Ugyldig eller skadet video.");
  const rotation = Math.abs(
    Number(v.tags?.rotate) || Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation) || 0,
  );
  const turned = rotation === 90 || rotation === 270;
  return {
    duration: Number(j.format?.duration),
    width: turned ? v.height : v.width,
    height: turned ? v.width : v.height,
  };
}

// Checks an uploaded file before it is accepted. Returns { fmt, duration }.
export async function validateUpload(file) {
  const fmt = sniff(head(file));
  if (!fmt) throw new VideoError("Ugyldig videoformat. Bruk MP4, MOV eller WebM.");
  const info = await probe(file, fmt);
  if (!Number.isFinite(info.duration) || info.duration <= 0)
    throw new VideoError("Kunne ikke lese lengden på videoen.");
  if (info.duration > VIDEO.maxSeconds + 0.5)
    throw new VideoError(`Videoen er for lang (maks ${VIDEO.maxSeconds} sekunder).`);
  if (info.width * info.height > VIDEO.maxPixels)
    throw new VideoError("Videoen har for høy oppløsning.");
  return { fmt, duration: info.duration };
}

// Compression steps, tried in order until the result is small enough.
export const LADDER = [
  { long: 1280, crf: 26, audio: 96 },
  { long: 1280, crf: 30, audio: 64 },
  { long: 960, crf: 32, audio: 64 },
  { long: 640, crf: 34, audio: 48 },
];

function encodeArgs(input, output, fmt, r) {
  return [
    "-nostdin", "-y", "-v", "error",
    "-protocol_whitelist", "file", "-f", fmt, "-i", input,
    "-t", String(VIDEO.maxSeconds + 0.5),
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `scale='min(${r.long},iw)':'min(${r.long},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(r.crf), "-profile:v", "high", "-threads", "2",
    "-c:a", "aac", "-b:a", `${r.audio}k`, "-ac", "2",
    "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn",
    "-movflags", "+faststart", "-fs", String(VIDEO.targetBytes * 3),
    output,
  ];
}

// Re-encodes to MP4 (H.264/AAC), stepping down quality and size until the file is
// at most the target size. A result up to twice the target is still accepted.
export async function compress(input, output, fmt) {
  let size = Infinity;
  for (let i = 0; i < LADDER.length; i++) {
    rmSync(output, { force: true });
    await tools.run("ffmpeg", encodeArgs(input, output, fmt, LADDER[i]), VIDEO.jobTimeoutMs);
    size = statSync(output).size;
    if (size <= VIDEO.targetBytes) return { attempts: i + 1, size };
  }
  if (size > VIDEO.targetBytes * 2)
    throw new VideoError("Videoen er for stor, selv etter komprimering.");
  return { attempts: LADDER.length, size };
}

// First usable frame as a JPEG buffer.
export async function extractPoster(file) {
  const out = path.join(incomingDir, `${randomUUID()}.jpg`);
  try {
    for (const seek of [["-ss", "0.5"], []]) {
      try {
        await tools.run(
          "ffmpeg",
          ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file", ...seek, "-f", "mov", "-i", file, "-frames:v", "1", "-q:v", "3", out],
          30_000,
        );
        if (existsSync(out) && statSync(out).size > 0) return readFileSync(out);
      } catch (e) {
        if (!seek.length) throw e;
      }
    }
    throw new Error("no frame extracted");
  } finally {
    rmSync(out, { force: true });
  }
}

// ---- Local copy on the volume (the object in storage stays the source of truth)
const downloads = new Map();
export async function videoFile(row) {
  const f = cacheFile(row.id);
  if (existsSync(f)) return f;
  if (!downloads.has(row.id)) {
    const job = (async () => {
      const buf = await storage.get(row.object_key);
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, f);
      return f;
    })().finally(() => downloads.delete(row.id));
    downloads.set(row.id, job);
  }
  return downloads.get(row.id);
}

export function removeVideoFiles(id) {
  for (const f of [cacheFile(id), incomingPath(id), `${incomingPath(id)}.out.mp4`]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* in use; sweepVideos removes it later */
    }
  }
}

// ---- Background queue ---------------------------------------------------------
const queue = [];
const queued = new Set(); // queued or running
let running = false;
export const queueLength = () => queued.size;

export function enqueueVideo(id) {
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  pump();
}
async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      try {
        await processVideo(id);
      } catch (e) {
        log.error("video_job_crashed", { photoId: id, ...errFields(e) });
      } finally {
        queued.delete(id);
      }
    }
  } finally {
    running = false;
  }
}
export const idle = async () => {
  while (running || queue.length) await new Promise((r) => setTimeout(r, 20));
};

const fail = (id, e) => {
  db.prepare("UPDATE photos SET media_status='failed' WHERE id=?").run(id);
  log.warn("video_processing_failed", {
    photoId: id,
    reason: e instanceof VideoError ? e.message : undefined,
    detail: e?.detail?.slice(-300),
    ...errFields(e),
  });
};

export async function processVideo(id) {
  const input = incomingPath(id);
  const output = `${input}.out.mp4`;
  const row = db
    .prepare("SELECT id,object_key,status FROM photos WHERE id=? AND media_type='video' AND media_status='processing'")
    .get(id);
  if (!row || row.status === "deleted") {
    removeVideoFiles(id);
    return;
  }
  let result;
  let info;
  try {
    const fmt = sniff(head(input));
    if (!fmt) throw new VideoError("Ugyldig videoformat.");
    result = await compress(input, output, fmt);
    info = await probe(output, "mov");
  } catch (e) {
    fail(id, e);
    removeVideoFiles(id);
    return;
  }
  try {
    await storage.put(row.object_key, readFileSync(output), "video/mp4");
  } catch (e) {
    // Stays "processing" with the upload kept; resumeVideos() tries again.
    log.error("video_store_failed", { photoId: id, ...errFields(e) });
    rmSync(output, { force: true });
    return;
  }
  // The customer may have removed it while we were working.
  if (db.prepare("SELECT status FROM photos WHERE id=?").get(id)?.status === "deleted") {
    try {
      await storage.del(row.object_key);
    } catch (e) {
      log.error("storage_delete_failed", { photoId: id, source: "video", ...errFields(e) });
    }
    removeVideoFiles(id);
    return;
  }
  renameSync(output, cacheFile(id));
  db.prepare("UPDATE photos SET media_status='ready',width=?,height=?,duration_ms=? WHERE id=?").run(
    info.width,
    info.height,
    Math.round((info.duration || 0) * 1000),
    id,
  );
  rmSync(input, { force: true });
  log.info("video_ready", { photoId: id, bytes: result.size, attempts: result.attempts });
}

// Re-queues videos that were interrupted by a restart or a storage error.
export function resumeVideos() {
  const rows = db
    .prepare("SELECT id FROM photos WHERE media_type='video' AND media_status='processing' AND status!='deleted'")
    .all();
  for (const r of rows) {
    if (existsSync(incomingPath(r.id))) enqueueVideo(r.id);
    else db.prepare("UPDATE photos SET media_status='failed' WHERE id=?").run(r.id);
  }
}

// Removes cached files whose photo is gone, and abandoned uploads older than an hour.
export function sweepVideos() {
  let removed = 0;
  try {
    const live = new Set(
      db.prepare("SELECT id FROM photos WHERE media_type='video' AND status!='deleted'").all().map((r) => r.id),
    );
    for (const name of readdirSync(cacheDir)) {
      if (!live.has(name.replace(/\.mp4(\.tmp)?$/, ""))) {
        rmSync(path.join(cacheDir, name), { force: true });
        removed++;
      }
    }
    const waiting = new Set(
      db
        .prepare("SELECT id FROM photos WHERE media_type='video' AND media_status='processing' AND status!='deleted'")
        .all()
        .map((r) => r.id),
    );
    for (const name of readdirSync(incomingDir)) {
      const file = path.join(incomingDir, name);
      if (waiting.has(name.split(".")[0]) || Date.now() - statSync(file).mtimeMs < 3600_000) continue;
      rmSync(file, { force: true });
      removed++;
    }
  } catch (e) {
    log.error("video_sweep_failed", errFields(e));
  }
  return removed;
}
