import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import {
  backupDatabase,
  backupIfDue,
  pruneBackups,
  verifyBackup,
  reconcile,
  retryDeletions,
  listBackups,
} from "../server/maintenance.js";

const schema = readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8");
let dir, db, store, storage;

function mockStorage() {
  store = new Map();
  return {
    put: async (k, b) => void store.set(k, b),
    get: async (k) => store.get(k),
    del: async (k) => void store.delete(k),
    list: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
  };
}
function addPhoto(id, status = "approved") {
  db.prepare(
    "INSERT INTO photos(id,object_key,status,gallery_consent,consent_version,consent_text,submitted_at,removal_token_hash) VALUES(?,?,?,1,'v','t','2026-10-01T00:00:00Z','h')",
  ).run(id, `photos/${id}.webp`, status);
}
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bf-maint-"));
  db = new Database(path.join(dir, "photos.sqlite"));
  db.exec(schema);
  db.exec("ALTER TABLE photos ADD COLUMN storage_deleted_at TEXT");
  storage = mockStorage();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("backup → restore check round trip preserves data", async () => {
  addPhoto("a");
  addPhoto("b", "pending");
  db.prepare(
    "INSERT INTO consent_events(id,photo_id,action,version,consent_text,marketing_consent,created_at) VALUES('e1','a','submitted','v','t',0,'now')",
  ).run();
  const r = await backupDatabase({ db, storage, dataDir: dir, keep: 14 });
  assert.match(r.key, /^backups\/photos-\d{8}T\d{6}Z\.sqlite\.gz$/);
  assert.ok(existsSync(path.join(dir, "backups", "latest.sqlite.gz")));
  const restoreTo = path.join(dir, "restored", "photos.sqlite");
  const v = verifyBackup(store.get(r.key), { restoreTo });
  assert.equal(v.ok, true);
  assert.deepEqual(v.photos, { approved: 1, pending: 1 });
  assert.equal(v.consentEvents, 1);
  // The restored file is a usable database containing the same rows.
  const restored = new Database(restoreTo, { readonly: true });
  assert.equal(restored.prepare("SELECT count(*) c FROM photos").get().c, 2);
  restored.close();
});

test("corrupt backup is rejected", () => {
  assert.throws(() => verifyBackup(Buffer.from("garbage")));
  assert.throws(() => verifyBackup(gzipSync(Buffer.from("not a sqlite file"))));
});

test("retention keeps newest N and never touches other objects", async () => {
  for (const d of ["20260101", "20260102", "20260103", "20260104"])
    store.set(`backups/photos-${d}T000000Z.sqlite.gz`, Buffer.from("x"));
  store.set("photos/keep.webp", Buffer.from("img"));
  store.set("backups/notes.txt", Buffer.from("hi"));
  const pruned = await pruneBackups({ storage, keep: 2 });
  assert.equal(pruned, 2);
  assert.deepEqual(await listBackups(storage), [
    "backups/photos-20260103T000000Z.sqlite.gz",
    "backups/photos-20260104T000000Z.sqlite.gz",
  ]);
  assert.ok(store.has("photos/keep.webp") && store.has("backups/notes.txt"));
});

test("backupIfDue skips when a recent backup exists, runs when stale", async () => {
  store.set("backups/photos-20200101T000000Z.sqlite.gz", Buffer.from("old"));
  assert.ok(await backupIfDue({ db, storage, dataDir: dir, keep: 14 }));
  assert.equal(await backupIfDue({ db, storage, dataDir: dir, keep: 14 }), null);
});

test("reconcile reports missing objects, pending deletions and orphans", async () => {
  addPhoto("ok");
  addPhoto("gone"); // row without object
  addPhoto("del", "deleted"); // deleted but object still stored
  addPhoto("done", "deleted"); // deleted and object gone
  store.set("photos/ok.webp", 1);
  store.set("photos/del.webp", 1);
  store.set("photos/stray.webp", 1); // object without row
  const r = await reconcile({ db, storage });
  assert.deepEqual(r.missingObjects, ["gone"]);
  assert.deepEqual(r.pendingDeletions, ["del"]);
  assert.deepEqual(r.orphanObjects, ["photos/stray.webp"]);
});

test("retryDeletions finishes only already-deleted photos; orphans are kept", async () => {
  addPhoto("ok");
  addPhoto("del", "deleted");
  store.set("photos/ok.webp", 1);
  store.set("photos/del.webp", 1);
  store.set("photos/stray.webp", 1);
  const r = await retryDeletions({ db, storage });
  assert.deepEqual(r, { done: 1, failed: [] });
  assert.ok(!store.has("photos/del.webp"));
  assert.ok(store.has("photos/ok.webp") && store.has("photos/stray.webp"));
  assert.ok(db.prepare("SELECT storage_deleted_at s FROM photos WHERE id='del'").get().s);
});

test("retryDeletions reports failures and leaves them retryable", async () => {
  addPhoto("del", "deleted");
  store.set("photos/del.webp", 1);
  storage.del = async () => { throw new Error("tigris down"); };
  const r = await retryDeletions({ db, storage });
  assert.deepEqual(r, { done: 0, failed: ["del"] });
  assert.equal(db.prepare("SELECT storage_deleted_at s FROM photos WHERE id='del'").get().s, null);
});
