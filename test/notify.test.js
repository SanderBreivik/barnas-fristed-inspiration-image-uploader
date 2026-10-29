import test from "node:test";
import assert from "node:assert/strict";
process.env.PUBLIC_ORIGIN ||= "https://x.test";
process.env.SHOP_ORIGIN ||= "https://s.test";
process.env.TURNSTILE_SITE_KEY ||= "a";
process.env.TURNSTILE_SECRET ||= "a";
process.env.ADMIN_PASSWORD ||= "a".repeat(24);
process.env.AWS_ENDPOINT_URL_S3 ||= "https://s3.test";
process.env.BUCKET_NAME ||= "b";
process.env.AWS_ACCESS_KEY_ID ||= "k";
process.env.AWS_SECRET_ACCESS_KEY ||= "s";
const { createNotifier } = await import("../server/notify.js");

test("sends nothing when unconfigured", async () => {
  const calls = [];
  await createNotifier({ env: {}, fetchFn: async (...a) => calls.push(a) })({ id: "1" });
  assert.equal(calls.length, 0);
});

test("sends email and messenger, survives failures", async () => {
  const calls = [];
  const n = createNotifier({
    env: {
      PUBLIC_ORIGIN: "https://x.test",
      RESEND_API_KEY: "k",
      NOTIFY_EMAIL_FROM: "a@b.no",
      NOTIFY_EMAIL_TO: "c@d.no",
      MESSENGER_PAGE_TOKEN: "t",
      MESSENGER_RECIPIENT_ID: "42",
    },
    fetchFn: async (url) => {
      calls.push(url);
      if (url.includes("resend")) throw Error("down");
      return { ok: true };
    },
  });
  await n({ id: "1" });
  assert.equal(calls.length, 2);
});
