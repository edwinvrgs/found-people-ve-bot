CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS found_people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  relevant_info TEXT,
  document_id TEXT,
  source_url TEXT NOT NULL,
  source_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'verified',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backward-compatible cleanup for the early Spanish-column prototype.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'nombre_completo')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'full_name') THEN
    ALTER TABLE found_people RENAME COLUMN nombre_completo TO full_name;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'informacion_relevante')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'relevant_info') THEN
    ALTER TABLE found_people RENAME COLUMN informacion_relevante TO relevant_info;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'fuente_url')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'source_url') THEN
    ALTER TABLE found_people RENAME COLUMN fuente_url TO source_url;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'hash_fuente')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'source_hash') THEN
    ALTER TABLE found_people RENAME COLUMN hash_fuente TO source_hash;
  END IF;
END $$;

ALTER TABLE found_people
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'verified',
  ADD COLUMN IF NOT EXISTS document_id TEXT;

UPDATE found_people
SET status = 'citizen_report'
WHERE raw->>'provider' = 'telegram_report'
  AND status = 'verified';

ALTER TABLE found_people
  ALTER COLUMN full_name SET NOT NULL,
  ALTER COLUMN source_url SET NOT NULL,
  ALTER COLUMN source_hash SET NOT NULL,
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'found_people_source_url_http_check') THEN
    ALTER TABLE found_people ADD CONSTRAINT found_people_source_url_http_check CHECK (source_url ~* '^https?://');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'found_people_status_check') THEN
    ALTER TABLE found_people ADD CONSTRAINT found_people_status_check CHECK (status IN ('verified', 'citizen_report', 'needs_review', 'removed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'found_people_document_id_check') THEN
    ALTER TABLE found_people ADD CONSTRAINT found_people_document_id_check CHECK (document_id IS NULL OR document_id ~ '^\d{6,9}$');
  END IF;
END $$;

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
