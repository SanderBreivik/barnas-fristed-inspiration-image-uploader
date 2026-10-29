// Entry point: builds the Express app from the modules and starts it.
// Tests import { app, db, storage } from here (NODE_ENV=test skips listening).
import express from "express";
import helmet from "helmet";
import { env } from "./config.js";
import { db } from "./db.js";
import { storage } from "./storage.js";
import { error } from "./util.js";
import { log, errFields } from "./log.js";
import { cors } from "./origins.js";
import { authRouter } from "./auth.js";
import { startLimitCleanup } from "./limits.js";
import { startBackgroundJobs } from "./jobs.js";
import { publicRouter } from "./routes/public.js";
import { submitRouter } from "./routes/submit.js";
import { submitVideoRouter } from "./routes/submit-video.js";
import { removalRouter } from "./routes/removal.js";
import { adminRouter } from "./routes/admin.js";

const app = express();

// One JSON access-log line per request. Query strings are never logged (they
// could contain tokens) and neither are IPs, bodies or cookies.
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    if (req.path === "/health" || req.path === "/health/deep") return;
    const status = res.statusCode;
    const fn = status >= 500 ? log.error : status >= 400 ? log.warn : log.info;
    fn("request", { method: req.method, path: req.path, status, ms: Date.now() - started });
  });
  res.on("close", () => {
    if (!res.writableFinished)
      log.warn("client_aborted", { method: req.method, path: req.path, ms: Date.now() - started });
  });
  next();
});
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));

// Order matters: admin login has its own small JSON parser and comes before
// the CORS/12 kB JSON middleware that applies to everything below.
app.use(authRouter);
app.use(cors);
app.use(express.json({ limit: "12kb" }));
app.use(publicRouter);
app.use(submitRouter);
app.use(submitVideoRouter);
app.use(removalRouter);
app.use(adminRouter);

// Must come after all routes. Never leaks error details to the client.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500)
    log.error("unhandled_error", { method: req.method, path: req.path, ...errFields(err) });
  else log.warn("bad_request", { method: req.method, path: req.path, status });
  error(res, status >= 500 ? "Internal error" : "Bad request", status);
});

startLimitCleanup();

export { app, db, storage };

const live = process.env.NODE_ENV !== "test" && !process.env.NO_LISTEN;
if (live) {
  // Memory, CPU, restarts and OOM kills are tracked by Fly (Grafana + `fly status`).
  log.info("startup", { node: process.version });
  startBackgroundJobs();

  process.on("uncaughtException", (e) => {
    log.fatal("uncaught_exception", errFields(e));
    setTimeout(() => process.exit(1), 500); // Fly restarts the machine
  });
  process.on("unhandledRejection", (e) => log.error("unhandled_rejection", errFields(e)));

  const port = Number(env.PORT || 8080);
  const server = app.listen(port, "0.0.0.0", () => log.info("listening", { port }));
  const shutdown = (signal) => {
    log.info("shutdown", { signal });
    server.close(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
