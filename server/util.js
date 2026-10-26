import { createHash } from "node:crypto";

export const sha = (s) => createHash("sha256").update(s).digest("hex");
export const now = () => new Date().toISOString();
export const clean = (x, max) => (typeof x === "string" ? x.trim().slice(0, max) : "");
export const error = (res, message, status = 400) => res.status(status).json({ error: message });
