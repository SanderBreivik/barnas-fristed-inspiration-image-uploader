// Cloudflare Turnstile verification (anti-bot). Uses the global fetch so tests can stub it.
import { env } from "./config.js";
import { isAllowedHostname } from "./origins.js";

export async function turnstile(token, ip) {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
    remoteip: ip,
  });
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true && isAllowedHostname(result.hostname);
}
