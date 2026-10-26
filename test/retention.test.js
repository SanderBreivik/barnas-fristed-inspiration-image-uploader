import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { enforceRetention } from "../server/maintenance.js";

const schema = readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8");
const NOW = Date.parse("2026-10-26T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

function setup() {
  const db = new Database(":memory:");
  db.exec(schema);
  db.exec("ALTER TABLE photos ADD COLUMN storage_deleted_at TEXT");
  const objects = new Set();
  const storage = {
    async del(k) {
      if (storage.fail) throw new Error("tigris down");
      objects.delete(k);
    },
  };
  const photo = (id, status, ageDays, extra = {}) => {
    objects.add(`photos/${id}.webp`);
    db.prepare(
      "INSERT INTO photos(id,object_key,display_name,description,status,gallery_consent,consent_version,consent_text,submitted_at,deleted_at,storage_deleted_at,removal_token_hash) VALUES(?,?,?,?,?,1,'v','t',?,?,?,'h')",
    ).run(id, `photos/${id}.webp`, "Navn", "Tekst", status, daysAgo(ageDays), extra.deletedAt ?? null, extra.storageDeletedAt ?? null);
  };
  const event = (photoId, ageDays) =>
    db
      .prepare("INSERT INTO consent_events VALUES(?,?,?,?,?,?,?)")
      .run(`e-${photoId}-${ageDays}`, photoId, "submitted", "v", "t", 0, daysAgo(ageDays));
  return { db, storage, objects, photo, event };
}
const status = (db, id) => db.prepare("SELECT * FROM photos WHERE id=?").get(id);

test("dry run reports but changes nothing", async () => {
  const { db, storage, objects, photo } = setup();
  photo("old", "pending", 45);
  const r = await enforceRetention({ db, storage, now: NOW });
  assert.equal(r.apply, false);
  assert.equal(r.expiredPhotos, 1);
  assert.equal(status(db, "old").status, "pending");
  assert.ok(objects.has("photos/old.webp"));
});

test("old pending and rejected photos expire; recent and approved are untouched", async () => {
  const { db, storage, objects, photo } = setup();
  photo("p-old", "pending", 45);
  photo("r-old", "rejected", 31);
  photo("p-new", "pending", 5);
  photo("a-old", "approved", 400);
  const r = await enforceRetention({ db, storage, now: NOW, apply: true });
  assert.equal(r.expiredPhotos, 2);
  for (const id of ["p-old", "r-old"]) {
    const row = status(db, id);
    assert.equal(row.status, "deleted");
    assert.ok(row.storage_deleted_at);
    assert.ok(!objects.has(`photos/${id}.webp`));
  }
  assert.equal(status(db, "p-new").status, "pending");
  assert.equal(status(db, "a-old").status, "approved");
  assert.ok(objects.has("photos/a-old.webp"));
  const ev = db.prepare("SELECT action FROM consent_events WHERE photo_id='p-old'").all();
  assert.deepEqual(ev.map((e) => e.action), ["expired"]);
});

test("storage failure keeps the photo unpublished and reports it", async () => {
  const { db, storage, photo } = setup();
  photo("p-old", "pending", 45);
  storage.fail = true;
  const r = await enforceRetention({ db, storage, now: NOW, apply: true });
  assert.deepEqual(r.storageFailures, ["p-old"]);
  const row = status(db, "p-old");
  assert.equal(row.status, "deleted");
  assert.equal(row.storage_deleted_at, null); // retryDeletions will finish it
});

test("personal text is scrubbed from deleted rows after the grace period", async () => {
  const { db, storage, photo } = setup();
  photo("d-old", "deleted", 90, { deletedAt: daysAgo(40), storageDeletedAt: daysAgo(40) });
  photo("d-new", "deleted", 90, { deletedAt: daysAgo(3), storageDeletedAt: daysAgo(3) });
  photo("d-pending", "deleted", 90, { deletedAt: daysAgo(40) }); // object not yet removed
  await enforceRetention({ db, storage, now: NOW, apply: true });
  assert.equal(status(db, "d-old").display_name, null);
  assert.equal(status(db, "d-old").description, null);
  assert.equal(status(db, "d-new").display_name, "Navn");
  assert.equal(status(db, "d-pending").display_name, "Navn");
});

test("consent log is kept 3 years and only purged for deleted photos", async () => {
  const { db, storage, photo, event } = setup();
  photo("gone", "deleted", 1500, { deletedAt: daysAgo(1400), storageDeletedAt: daysAgo(1400) });
  photo("live", "approved", 1500);
  event("gone", 1200); // older than 3 years: purged
  event("gone", 100); // recent: kept
  event("live", 1200); // photo still published: kept
  const r = await enforceRetention({ db, storage, now: NOW, apply: true });
  assert.equal(r.purgedConsentEvents, 1);
  const left = db.prepare("SELECT photo_id FROM consent_events ORDER BY id").all().map((e) => e.photo_id);
  assert.deepEqual(left.sort(), ["gone", "live"]);
});

test("batch size limits one run; the rest is handled next time", async () => {
  const { db, storage, photo } = setup();
  for (let i = 0; i < 5; i++) photo(`p${i}`, "pending", 60 + i);
  const r1 = await enforceRetention({ db, storage, now: NOW, apply: true, batch: 3 });
  assert.equal(r1.expiredPhotos, 3);
  const r2 = await enforceRetention({ db, storage, now: NOW, apply: true, batch: 3 });
  assert.equal(r2.expiredPhotos, 2);
});
