// SQLite database: opens the file, applies the schema and additive migrations.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dataDir, root } from "./config.js";

export const db = new Database(path.join(dataDir, "photos.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(readFileSync(path.join(root, "schema.sql"), "utf8"));

// Additive migration: tracks whether the stored object is confirmed deleted.
// Back up photos.sqlite before first deploy (see README).
if (!db.prepare("PRAGMA table_info(photos)").all().some((c) => c.name === "storage_deleted_at"))
  db.exec("ALTER TABLE photos ADD COLUMN storage_deleted_at TEXT");
