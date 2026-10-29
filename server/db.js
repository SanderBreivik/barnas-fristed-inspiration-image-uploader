// SQLite database: opens the file, applies the schema and additive migrations.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dataDir, root } from "./config.js";

export const db = new Database(path.join(dataDir, "photos.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(readFileSync(path.join(root, "schema.sql"), "utf8"));

// Additive migrations. Back up photos.sqlite before first deploy (see README).
const columns = db.prepare("PRAGMA table_info(photos)").all().map((c) => c.name);
// Tracks whether the stored object is confirmed deleted.
if (!columns.includes("storage_deleted_at"))
  db.exec("ALTER TABLE photos ADD COLUMN storage_deleted_at TEXT");
// Pixel size of the stored image (lets the gallery reserve space; old rows are
// filled in the first time a thumbnail is generated).
if (!columns.includes("width")) db.exec("ALTER TABLE photos ADD COLUMN width INTEGER");
if (!columns.includes("height")) db.exec("ALTER TABLE photos ADD COLUMN height INTEGER");
// Video support: existing rows are images that are ready. media_status goes
// processing -> ready, or failed (videos are compressed in the background).
if (!columns.includes("media_type"))
  db.exec("ALTER TABLE photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'");
if (!columns.includes("media_status"))
  db.exec("ALTER TABLE photos ADD COLUMN media_status TEXT NOT NULL DEFAULT 'ready'");
if (!columns.includes("duration_ms")) db.exec("ALTER TABLE photos ADD COLUMN duration_ms INTEGER");
