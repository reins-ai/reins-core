-- 002_memory_search.sql
-- Search and embedding storage (FTS5 + vector metadata).

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
USING fts5(
  memory_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  version TEXT NOT NULL DEFAULT '1',
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_sources (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  include_patterns TEXT,
  exclude_patterns TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_indexed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory_id
  ON memory_embeddings(memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_provider_model
  ON memory_embeddings(provider, model);

CREATE INDEX IF NOT EXISTS idx_document_chunks_source_id
  ON document_chunks(source_id);

CREATE INDEX IF NOT EXISTS idx_document_chunks_file_path
  ON document_chunks(file_path);

CREATE TRIGGER IF NOT EXISTS trg_memory_fts_insert
AFTER INSERT ON memories
BEGIN
  INSERT INTO memory_fts (memory_id, content)
  VALUES (NEW.id, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_fts_update
AFTER UPDATE OF content ON memories
BEGIN
  DELETE FROM memory_fts
  WHERE memory_id = NEW.id;

  INSERT INTO memory_fts (memory_id, content)
  VALUES (NEW.id, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_fts_delete
AFTER DELETE ON memories
BEGIN
  DELETE FROM memory_fts
  WHERE memory_id = OLD.id;
END;

INSERT INTO memory_fts (memory_id, content)
SELECT memories.id, memories.content
FROM memories
WHERE NOT EXISTS (
  SELECT 1
  FROM memory_fts
  WHERE memory_fts.memory_id = memories.id
);
