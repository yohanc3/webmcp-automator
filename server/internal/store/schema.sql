CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT REFERENCES sites(id),
  goal TEXT NOT NULL,
  start_url TEXT NOT NULL DEFAULT '',
  final_url TEXT NOT NULL DEFAULT '',
  trace_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recorded', 'learning', 'candidate', 'failed')),
  model TEXT,
  response_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS adapters (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'degraded', 'unresolved', 'archived')),
  active_version_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(site_id, tool_name)
);

CREATE TABLE IF NOT EXISTS adapter_versions (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL REFERENCES adapters(id),
  version INTEGER NOT NULL,
  manifest_json JSONB NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  source_session_id TEXT REFERENCES learning_sessions(id),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'superseded', 'rejected')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(adapter_id, version)
);

CREATE TABLE IF NOT EXISTS adapter_runs (
  id TEXT PRIMARY KEY,
  adapter_version_id TEXT NOT NULL REFERENCES adapter_versions(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  failed_step INTEGER,
  url TEXT NOT NULL DEFAULT '',
  error TEXT,
  observed_json JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS action_maps (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  source_session_id TEXT NOT NULL UNIQUE REFERENCES learning_sessions(id),
  schema_version TEXT NOT NULL,
  map_json JSONB NOT NULL,
  model TEXT,
  response_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

-- Ambient action-map revisions contain only the canonical materialized map and
-- privacy-safe provenance/evidence metadata. Source XML, observations, prompt
-- bodies, typed values, and browsing history never have columns here.
CREATE TABLE IF NOT EXISTS action_map_scopes (
  scope_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  route_patterns_json JSONB NOT NULL,
  head_revision INTEGER NOT NULL DEFAULT 0,
  head_digest TEXT,
  last_layer_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((head_revision = 0 AND head_digest IS NULL) OR
         (head_revision > 0 AND head_digest IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS action_map_revisions (
  scope_id TEXT NOT NULL REFERENCES action_map_scopes(scope_id),
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  source_layer_sequence INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  document_json JSONB NOT NULL,
  evidence_metadata_json JSONB NOT NULL,
  parser_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_id, revision)
);

CREATE TABLE IF NOT EXISTS action_map_receipts (
  scope_id TEXT NOT NULL REFERENCES action_map_scopes(scope_id),
  idempotency_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  source_layer_sequence INTEGER NOT NULL,
  receipt_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_id, idempotency_key)
);

-- action_lists and their revisions replace the paused learned-adapter tables as
-- the only publication source of truth. The legacy tables remain readable for
-- non-destructive database upgrades, but new registry code never writes them.
CREATE TABLE IF NOT EXISTS action_lists (
  list_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS action_list_revisions (
  list_id TEXT NOT NULL REFERENCES action_lists(list_id),
  revision INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  document_json JSONB NOT NULL,
  source_map_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (list_id, revision),
  UNIQUE (list_id, candidate_digest)
);

-- Ambient candidates are bound to the exact immutable action-map revision
-- that produced them. This is deliberately separate from the action-list JSON:
-- clients must not be able to assert an evidence binding by editing a document.
CREATE TABLE IF NOT EXISTS action_list_candidate_bindings (
  list_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  candidate_digest TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  action_map_revision INTEGER NOT NULL,
  action_map_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (list_id, revision),
  FOREIGN KEY (list_id, revision) REFERENCES action_list_revisions(list_id, revision)
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  candidate_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'unknown')),
  scopes_json JSONB NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (list_id, revision) REFERENCES action_list_revisions(list_id, revision)
);

CREATE TABLE IF NOT EXISTS replay_reports (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  candidate_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  report_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (list_id, revision) REFERENCES action_list_revisions(list_id, revision)
);

CREATE TABLE IF NOT EXISTS action_list_reviews (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  candidate_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  reviewer TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (list_id, revision) REFERENCES action_list_revisions(list_id, revision)
);

CREATE TABLE IF NOT EXISTS action_list_publications (
  id TEXT NOT NULL UNIQUE,
  list_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  candidate_digest TEXT NOT NULL,
  published_digest TEXT NOT NULL UNIQUE,
  published_json JSONB NOT NULL,
  policy_decision_id TEXT NOT NULL REFERENCES policy_decisions(id),
  replay_report_id TEXT NOT NULL REFERENCES replay_reports(id),
  review_id TEXT NOT NULL REFERENCES action_list_reviews(id),
  published_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (list_id, revision),
  UNIQUE (list_id, published_digest),
  FOREIGN KEY (list_id, revision) REFERENCES action_list_revisions(list_id, revision)
);

CREATE TABLE IF NOT EXISTS run_observations (
  run_id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  list_digest TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
  observation_json JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (list_id, list_digest) REFERENCES action_list_publications(list_id, published_digest)
);

CREATE INDEX IF NOT EXISTS learning_sessions_created_at_idx
  ON learning_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS adapter_versions_adapter_idx
  ON adapter_versions(adapter_id, version DESC);
CREATE INDEX IF NOT EXISTS adapter_runs_version_idx
  ON adapter_runs(adapter_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS action_maps_site_idx
  ON action_maps(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS action_map_revisions_scope_idx
  ON action_map_revisions(scope_id, revision DESC);
CREATE INDEX IF NOT EXISTS action_lists_origin_idx
  ON action_lists(origin);
CREATE INDEX IF NOT EXISTS action_list_publications_latest_idx
  ON action_list_publications(list_id, revision DESC);
CREATE INDEX IF NOT EXISTS run_observations_digest_idx
  ON run_observations(list_digest, action_id, created_at DESC);
