-- 001_memory_core.sql
-- Core durable storage for memories, provenance, and consolidation runs.

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  layer TEXT NOT NULL DEFAULT 'stm' CHECK (layer IN ('stm', 'ltm')),
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0.0 AND importance <= 1.0),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  tags TEXT,
  entities TEXT,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('explicit', 'implicit', 'compaction', 'consolidation', 'document')
  ),
  source_conversation_id TEXT,
  source_message_id TEXT,
  supersedes_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  superseded_by_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  reinforcement_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_provenance (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'consolidated', 'superseded')),
  source_details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS consolidation_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  stm_count INTEGER NOT NULL,
  promoted_count INTEGER NOT NULL DEFAULT 0,
  merged_count INTEGER NOT NULL DEFAULT 0,
  error_details TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_type
  ON memories(type);

CREATE INDEX IF NOT EXISTS idx_memories_layer
  ON memories(layer);

CREATE INDEX IF NOT EXISTS idx_memories_source_type
  ON memories(source_type);

CREATE INDEX IF NOT EXISTS idx_memories_importance
  ON memories(importance DESC);

CREATE INDEX IF NOT EXISTS idx_memories_created_at
  ON memories(created_at DESC);
