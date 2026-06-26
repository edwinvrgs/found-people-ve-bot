CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS found_people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  relevant_info TEXT,
  document_id TEXT CONSTRAINT found_people_document_id_check CHECK (document_id IS NULL OR document_id ~ '^\d{6,9}$'),
  source_url TEXT NOT NULL CONSTRAINT found_people_source_url_http_check CHECK (source_url ~* '^https?://'),
  source_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'verified' CONSTRAINT found_people_status_check CHECK (status IN ('verified', 'citizen_report', 'needs_review', 'removed')),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE INDEX IF NOT EXISTS idx_found_people_full_name ON found_people (lower(full_name));
CREATE INDEX IF NOT EXISTS idx_found_people_full_name_trgm ON found_people USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_found_people_document_id ON found_people (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_found_people_status ON found_people (status);
CREATE INDEX IF NOT EXISTS idx_found_people_updated_at ON found_people (updated_at DESC);

CREATE TABLE IF NOT EXISTS bot_metrics (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
