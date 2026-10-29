CREATE TABLE IF NOT EXISTS photos (
 id TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE, display_name TEXT, description TEXT,
 product_handle TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','deleted')),
 gallery_consent INTEGER NOT NULL CHECK(gallery_consent=1), marketing_consent INTEGER NOT NULL DEFAULT 0,
 consent_version TEXT NOT NULL, consent_text TEXT NOT NULL, submitted_at TEXT NOT NULL,
 approved_at TEXT, deleted_at TEXT, removal_token_hash TEXT NOT NULL,
 media_type TEXT NOT NULL DEFAULT 'image', media_status TEXT NOT NULL DEFAULT 'ready', duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_photos_public ON photos(status,approved_at);
CREATE TABLE IF NOT EXISTS consent_events (
 id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, action TEXT NOT NULL,
 version TEXT NOT NULL, consent_text TEXT NOT NULL, marketing_consent INTEGER NOT NULL,
 created_at TEXT NOT NULL, FOREIGN KEY(photo_id) REFERENCES photos(id)
);
CREATE TABLE IF NOT EXISTS request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
