PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT REFERENCES sites(id),
  goal TEXT NOT NULL,
  start_url TEXT NOT NULL DEFAULT '',
  final_url TEXT NOT NULL DEFAULT '',
  trace_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recorded', 'learning', 'candidate', 'failed')),
  model TEXT,
  response_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adapters (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'degraded', 'unresolved', 'archived')),
  active_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(site_id, tool_name)
);

CREATE TABLE IF NOT EXISTS adapter_versions (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL REFERENCES adapters(id),
  version INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_session_id TEXT REFERENCES learning_sessions(id),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'superseded', 'rejected')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(adapter_id, version)
);

CREATE TABLE IF NOT EXISTS adapter_runs (
  id TEXT PRIMARY KEY,
  adapter_version_id TEXT NOT NULL REFERENCES adapter_versions(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  failed_step INTEGER,
  url TEXT NOT NULL DEFAULT '',
  error TEXT,
  observed_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_maps (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  source_session_id TEXT NOT NULL UNIQUE REFERENCES learning_sessions(id),
  schema_version TEXT NOT NULL,
  map_json TEXT NOT NULL,
  model TEXT,
  response_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS learning_sessions_created_at_idx
  ON learning_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS adapter_versions_adapter_idx
  ON adapter_versions(adapter_id, version DESC);
CREATE INDEX IF NOT EXISTS adapter_runs_version_idx
  ON adapter_runs(adapter_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS action_maps_site_idx
  ON action_maps(site_id, created_at DESC);
