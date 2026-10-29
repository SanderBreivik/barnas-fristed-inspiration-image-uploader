// Gallery thumbnails. Generated on first request from the stored image, cached
// on the data volume and re-creatable at any time (nothing here is a source of
// truth). Only approved photos are ever served, so a cached file for a photo
// that is later unpublished is never reachable; sweepThumbs() also removes it.
import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { dataDir, env, num } from "./config.js";
import { db } from "./db.js";
import { storage } from "./storage.js";
import { log, errFields } from "./log.js";
import { extractPoster, videoFile, removeVideoFiles } from "./video.js";

export const THUMB_WIDTH = num(env.THUMB_WIDTH, 720);
const dir = path.join(dataDir, "thumbs");
mkdirSync(dir, { recursive: true });
const file = (id) => path.join(dir, `${id}.webp`);

sharp.cache(false);
sharp.concurrency(1);

// At most N thumbnails are generated at once; the rest wait (a first gallery
// page asks for 24 at the same time).
const MAX_JOBS = num(env.THUMB_MAX_CONCURRENCY, 2);
let active = 0;
const waiting = [];
const limited = (fn) =>
  new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          waiting.shift()?.();
        });
    };
    active < MAX_JOBS ? run() : waiting.push(run);
  });

const inFlight = new Map(); // id -> Promise<Buffer>, so duplicate requests share one job

async function generate(row) {
  let buf;
  if (row.media_type === "video") {
    const frame = await extractPoster(await videoFile(row));
    buf = await sharp(frame).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  } else {
    const full = await storage.get(row.object_key);
    const meta = await sharp(full).metadata();
    buf = await sharp(full)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    if (meta.width && meta.height)
      db.prepare("UPDATE photos SET width=?,height=? WHERE id=? AND (width IS NULL OR height IS NULL)").run(
        meta.width,
        meta.height,
        row.id,
      );
  }
  try {
    const tmp = `${file(row.id)}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, file(row.id));
  } catch (e) {
    log.warn("thumb_cache_write_failed", errFields(e)); // still serve the thumbnail
  }
  return buf;
}

// row: { id, object_key, media_type }
export async function getThumb(row) {
  try {
    return readFileSync(file(row.id));
  } catch {
    /* not cached yet */
  }
  if (!inFlight.has(row.id)) {
    const job = limited(() => generate(row)).finally(() => inFlight.delete(row.id));
    inFlight.set(row.id, job);
  }
  return inFlight.get(row.id);
}

export function removeThumb(id) {
  rmSync(file(id), { force: true });
}

// Cached files of a photo that is no longer public (thumbnail and video copy).
export function removeMedia(id) {
  removeThumb(id);
  removeVideoFiles(id);
}

// Deletes cached thumbnails whose photo is not (or no longer) approved.
export function sweepThumbs() {
  let removed = 0;
  try {
    const approved = new Set(
      db.prepare("SELECT id FROM photos WHERE status='approved'").all().map((r) => r.id),
    );
    for (const name of readdirSync(dir)) {
      const id = name.replace(/\.webp(\.tmp)?$/, "");
      if (!approved.has(id)) {
        rmSync(path.join(dir, name), { force: true });
        removed++;
      }
    }
  } catch (e) {
    log.error("thumb_sweep_failed", errFields(e));
  }
  return removed;
}
