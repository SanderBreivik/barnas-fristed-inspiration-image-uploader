// Which origins may call the API (CORS + Origin checks) and Turnstile hostnames.
import { env } from "./config.js";
import { error } from "./util.js";

// Explicit allowlist plus Shopify's preview hosts (theme editor / preview links),
// which have random subdomains. Set ALLOW_SHOPIFY_PREVIEW=false to disable the
// latter. Extra exact origins: EXTRA_ORIGINS="https://x.example,…".
const PREVIEW_HOST = /^[a-z0-9-]+\.shopifypreview\.com$/;
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.shopifypreview\.com$/;
const allowedOrigins = new Set(
  [
    "https://barnasfristed.no",
    "https://www.barnasfristed.no",
    "https://barnas-fristed.myshopify.com",
    env.SHOP_ORIGIN,
    ...String(env.EXTRA_ORIGINS || "").split(","),
  ]
    .map((o) => o?.trim().replace(/\/$/, ""))
    .filter(Boolean),
);

export const isAllowedOrigin = (origin) => {
  if (allowedOrigins.has(origin)) return true;
  if (env.ALLOW_SHOPIFY_PREVIEW === "false") return false;
  return PREVIEW_ORIGIN.test(origin || "");
};

// Turnstile reports the hostname the widget ran on; accept the same hosts.
const allowedHostnames = new Set([...allowedOrigins].map((o) => new URL(o).hostname));
export const isAllowedHostname = (hostname) =>
  allowedHostnames.has(hostname) ||
  (env.ALLOW_SHOPIFY_PREVIEW !== "false" && PREVIEW_HOST.test(hostname || ""));

export const cors = (req, res, next) => {
  const origin = req.get("origin");
  res.vary("Origin");
  const allowed = isAllowedOrigin(origin);
  if (allowed) res.set("Access-Control-Allow-Origin", origin);
  if (req.method === "OPTIONS") {
    if (allowed) {
      res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Access-Control-Max-Age", "600");
    }
    return res.sendStatus(204);
  }
  next();
};

export const allowOrigin = (req, res, next) =>
  isAllowedOrigin(req.get("origin")) ? next() : error(res, "Invalid origin", 403);

// Removal is also used from remove.html, which is served by this backend
// (same-origin), so PUBLIC_ORIGIN is accepted in addition to storefront origins.
// Authorization is the removal token, not the origin.
export const allowRemovalOrigin = (req, res, next) => {
  const origin = req.get("origin");
  return isAllowedOrigin(origin) || origin === env.PUBLIC_ORIGIN
    ? next()
    : error(res, "Invalid origin", 403);
};

// For admin actions: only the backend's own pages (admin.html) may call.
export const sameOriginOnly = (req, res, next) =>
  req.get("origin") === env.PUBLIC_ORIGIN ? next() : error(res, "Invalid origin", 403);
