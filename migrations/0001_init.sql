-- Document registry: one row per scraped document (law or court act).
-- content_hash drives change detection for the daily incremental runs.
CREATE TABLE IF NOT EXISTS documents (
  doc_id TEXT PRIMARY KEY,          -- e.g. "lexbg:2135180800" or "vks:51A2C407C78E4687C2258542003C0139"
  source TEXT NOT NULL,             -- "lexbg" | "vks"
  url TEXT NOT NULL,
  title TEXT,
  content_hash TEXT,                -- sha256 of extracted plain text
  chunk_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | indexed | error
  error TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  last_indexed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);

-- Lightweight crawl diary; useful to spot a discovery step that suddenly finds 0 links
-- (e.g. a markup change on lex.bg or wrong VKS form parameters).
CREATE TABLE IF NOT EXISTS crawl_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,
  event TEXT NOT NULL,              -- discover | error | kickoff
  detail TEXT
);
