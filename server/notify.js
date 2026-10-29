// Notifies the owner about new submissions by email (Resend API) and/or
// Facebook Messenger (Send API). Both are optional and best-effort: failures are
// logged and never affect the upload. No personal data from the submitter is sent.
import { env } from "./config.js";
import { log } from "./log.js";

export function createNotifier({ env: e = env, fetchFn = (...a) => globalThis.fetch(...a) } = {}) {
  const post = async (name, url, init) => {
    try {
      const r = await fetchFn(url, init);
      if (!r.ok) log.warn("notify_failed", { channel: name, status: r.status });
    } catch {
      log.warn("notify_failed", { channel: name });
    }
  };
  return ({ id, media = "image" }) => {
    const kind = media === "video" ? "video" : "bilde";
    const text = `Nytt ${kind} er sendt inn og venter på godkjenning: ${e.PUBLIC_ORIGIN}/admin (id ${id})`;
    const jobs = [];
    if (e.NOTIFY_EMAIL_TO && e.NOTIFY_EMAIL_FROM && e.RESEND_API_KEY)
      jobs.push(
        post("email", "https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + e.RESEND_API_KEY,
          },
          body: JSON.stringify({
            from: e.NOTIFY_EMAIL_FROM,
            to: e.NOTIFY_EMAIL_TO.split(",").map((s) => s.trim()),
            subject: `Nytt ${kind} til godkjenning`,
            text,
          }),
        }),
      );
    if (e.MESSENGER_PAGE_TOKEN && e.MESSENGER_RECIPIENT_ID)
      jobs.push(
        post("messenger", "https://graph.facebook.com/v21.0/me/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + e.MESSENGER_PAGE_TOKEN,
          },
          body: JSON.stringify({
            recipient: { id: e.MESSENGER_RECIPIENT_ID },
            messaging_type: "MESSAGE_TAG",
            tag: "ACCOUNT_UPDATE",
            message: { text },
          }),
        }),
      );
    return Promise.all(jobs);
  };
}

export const notifySubmission = createNotifier();
