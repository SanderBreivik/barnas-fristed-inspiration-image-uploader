#!/usr/bin/env node
// Verify (and optionally restore) a database backup without touching the live DB.
//   node server/restore-check.js backup.sqlite.gz
//   node server/restore-check.js backup.sqlite.gz --to ./restored/photos.sqlite
import { readFileSync } from "node:fs";
import { verifyBackup } from "./maintenance.js";

const [file, flag, target] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node server/restore-check.js <backup.sqlite.gz> [--to <path>]");
  process.exit(2);
}
try {
  const result = verifyBackup(readFileSync(file), {
    restoreTo: flag === "--to" ? target : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (e) {
  console.error(`Backup is not usable: ${e.message}`);
  process.exit(1);
}
