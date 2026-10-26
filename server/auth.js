// Admin authentication: password -> server-side session in an HttpOnly cookie.
// Sessions live in memory (single Fly machine); a restart logs admins out.
import express, { Router } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./config.js";
import { sha, error } from "./util.js";
import { log } from "./log.js";
import { sameOriginOnly } from "./origins.js";

const SESSION_TTL_MS = Number(env.ADMIN_SESSION_TTL_MS) || 8 * 3600_000;
const SESSION_IDLE_MS = Number(env.ADMIN_SESSION_IDLE_MS) || 30 * 60_000;
const LOGIN_MAX_FAILS = Number(env.ADMIN_LOGIN_MAX_FAILS) || 5;
const LOGIN_WINDOW_MS = Number(env.ADMIN_LOGIN_WINDOW_MS) || 15 * 60_000;
const COOKIE = "__Host-bf_admin";
const sessions = new Map(); // sid -> {csrf, created, last}
const loginFails = new Map(); // ip hash -> {count, resetAt}

setInterval(() => {
  const t = Date.now();
  for (const [k, s] of sessions)
    if (t - s.created > SESSION_TTL_MS || t - s.last > SESSION_IDLE_MS) sessions.delete(k);
  for (const [k, f] of loginFails) if (f.resetAt < t) loginFails.delete(k);
}, 60_000).unref();

const safeEqual = (a, b) =>
  timingSafeEqual(Buffer.from(sha(String(a)), "hex"), Buffer.from(sha(String(b)), "hex"));

const readCookie = (req, name) => {
  for (const part of (req.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
};
const cookieOpts = (maxAge) => `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// Middleware: valid session required; non-GET also needs the CSRF header.
export const admin = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const sid = readCookie(req, COOKIE);
  const s = sessions.get(sid);
  const t = Date.now();
  if (!s || t - s.created > SESSION_TTL_MS || t - s.last > SESSION_IDLE_MS) {
    sessions.delete(sid);
    return error(res, "Unauthorized", 401);
  }
  if (req.method !== "GET" && !safeEqual(req.get("x-csrf-token") || "", s.csrf))
    return error(res, "Invalid CSRF token", 403);
  s.last = t;
  req.adminSession = sid;
  next();
};

export const authRouter = Router();

authRouter.post("/api/admin/login", sameOriginOnly, express.json({ limit: "2kb" }), (req, res) => {
  res.set("Cache-Control", "no-store");
  const key = sha(req.ip || "unknown"), t = Date.now();
  let f = loginFails.get(key);
  if (!f || f.resetAt < t) loginFails.set(key, (f = { count: 0, resetAt: t + LOGIN_WINDOW_MS }));
  if (f.count >= LOGIN_MAX_FAILS) {
    res.set("Retry-After", String(Math.ceil((f.resetAt - t) / 1000)));
    return error(res, "Too many attempts. Try again later.", 429);
  }
  const pw = req.body?.password;
  if (typeof pw !== "string" || !safeEqual(pw, env.ADMIN_PASSWORD)) {
    f.count++;
    log.warn("admin_login_failed");
    return error(res, "Unauthorized", 401);
  }
  loginFails.delete(key);
  const sid = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
  sessions.set(sid, { csrf, created: t, last: t });
  res.set("Set-Cookie", `${COOKIE}=${sid}; ${cookieOpts(Math.floor(SESSION_TTL_MS / 1000))}`);
  res.json({ ok: true, csrf });
});

authRouter.post("/api/admin/logout", sameOriginOnly, admin, (req, res) => {
  sessions.delete(req.adminSession);
  res.set("Set-Cookie", `${COOKIE}=; ${cookieOpts(0)}`);
  res.json({ ok: true });
});

authRouter.get("/api/admin/session", admin, (req, res) =>
  res.json({ ok: true, csrf: sessions.get(req.adminSession).csrf }),
);
