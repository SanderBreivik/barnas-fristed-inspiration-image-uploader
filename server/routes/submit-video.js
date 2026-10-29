// POST /api/submit-video: accept the upload on disk, validate it with ffprobe and
// answer right away; compression happens in the background (see ../video.js).
import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { db } from "../db.js";
import { error } from "../util.js";
import { log, errFields } from "../log.js";
import { allowOrigin } from "../origins.js";
import { LIMITS, hit, submitAbuseLimit } from "../limits.js";
import { admit, record } from "./submit.js";
import {
  VIDEO,
  VideoError,
  enqueueVideo,
  incomingDir,
  incomingPath,
  queueLength,
  validateUpload,
} from "../video.js";
import path from "node:path";

export const submitVideoRouter = Router();

// Tells the form that the chosen file is the problem, so it can clear the field.
const FILE = { field: "file" };

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, incomingDir),
    filename: (req, _file, cb) => cb(null, path.basename(incomingPath(req.videoId))),
  }),
  limits: { fileSize: VIDEO.maxUploadBytes, files: 1, fields: 12 },
});

const assignId = (req, _res, next) => {
  req.videoId = randomUUID();
  next();
};

const uploadOne = (req, res, next) =>
  upload.single("video")(req, res, (err) => {
    if (!err) return next();
    log.warn("upload_rejected", { code: err.code || "unknown", kind: "video" });
    if (err.code === "LIMIT_FILE_SIZE")
      return error(res, `Videoen er for stor (maks ${Math.round(VIDEO.maxUploadBytes / 1048576)} MB).`, 413, FILE);
    return error(res, "Ugyldig opplasting.", 400);
  });

submitVideoRouter.post(
  "/api/submit-video",
  allowOrigin,
  submitAbuseLimit,
  assignId,
  uploadOne,
  async (req, res) => {
    const file = req.file?.path;
    let accepted = false;
    try {
      const ctx = await admit(req, res, "Video required");
      if (!ctx) return;
      if (queueLength() >= VIDEO.queueMax) {
        res.set("Retry-After", "60");
        return error(res, "Serveren behandler mange videoer akkurat nå. Prøv igjen om litt.", 503);
      }
      let info;
      try {
        info = await validateUpload(file);
      } catch (e) {
        if (e instanceof VideoError) {
          log.warn("video_rejected", { reason: e.message });
          return error(res, e.userMessage, 400, FILE);
        }
        log.warn("video_probe_failed", errFields(e));
        return error(res, "Ugyldig eller skadet video.", 400, FILE);
      }
      const id = req.videoId,
        token = randomUUID() + randomUUID();
      record(req, {
        id,
        token,
        key: `photos/${id}.mp4`,
        product: ctx.product,
        media: "video",
        durationMs: Math.round(info.duration * 1000),
        keepAudio: req.body.includeAudio === "true",
      });
      accepted = true;
      hit(ctx.quotaKey, LIMITS.quotaWindow);
      enqueueVideo(id);
      res.status(201).json({
        ok: true,
        id,
        removalToken: token,
        message: "Videoen er sendt til godkjenning.",
      });
    } catch (e) {
      log.error("submit_failed", { kind: "video", ...errFields(e) });
      error(res, "Noe gikk galt under opplasting. Prøv igjen senere.", 500);
    } finally {
      if (!accepted && file) rmSync(file, { force: true });
    }
  },
);
