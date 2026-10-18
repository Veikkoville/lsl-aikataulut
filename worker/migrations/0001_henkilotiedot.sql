-- Henkilötiedot EU-jurisdiktiossa (D1-kanta reittari-henkilotiedot, luotu --jurisdiction=eu 18.10.2026).
-- Avain-arvo-taulu, jonka rajapinta vastaa Workers KV:tä (ks. personalKv worker.js:ssä), jotta
-- tilausten, muistutusten, palautteen ja uusintapainatusvahdin logiikka säilyy ennallaan.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER -- unix-sekunteina; NULL = ei vanhene
);
CREATE INDEX IF NOT EXISTS kv_expires_at ON kv (expires_at) WHERE expires_at IS NOT NULL;
