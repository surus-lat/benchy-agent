-- The paper library: CONICET Digital's publications (UNRN/ri-conicet on
-- Hugging Face), searched by title, authors, subjects and abstract.
-- One table and an external-content full-text index over it. The index is
-- written explicitly next to each insert and delete (no triggers: SQLite with
-- trusted_schema off refuses triggers that write a virtual table). build.py
-- writes this schema followed by the data; apps/api/src/library.ts reads it.

CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY,        -- DSpace item id (handle 11336/<id>), or the BICyT production id
  title TEXT NOT NULL,
  creators TEXT NOT NULL,        -- JSON array of "Surname, Name"
  subjects TEXT NOT NULL,        -- JSON array
  description TEXT NOT NULL,     -- the abstract
  date TEXT NOT NULL,            -- YYYY, YYYY-MM or YYYY-MM-DD, as recorded
  year INTEGER,
  type TEXT NOT NULL,            -- article, thesis, book, dataset, other
  language TEXT NOT NULL,        -- ISO 639-2 (spa, eng, por, ...)
  publisher TEXT NOT NULL,
  rights TEXT NOT NULL,
  pdf TEXT,                      -- papers/<shard>/<id>.pdf in the dataset, files/<key> in KV, or NULL
  origin TEXT NOT NULL DEFAULT 'conicet', -- conicet (CONICET Digital) | bicyt (BICyT record, external.json)
  url TEXT                       -- the record's page when it is not CONICET Digital's handle
);

CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  title, creators, subjects, description,
  content='papers', content_rowid='id',
  detail=column,
  tokenize='unicode61 remove_diacritics 2'
);

-- Counts and snapshot date for the library page, refreshed by every import.
CREATE TABLE IF NOT EXISTS library_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
