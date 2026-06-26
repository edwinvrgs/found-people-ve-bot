CREATE TABLE IF NOT EXISTS found_people_merge_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id UUID NOT NULL REFERENCES found_people(id),
  duplicate_id UUID NOT NULL REFERENCES found_people(id),
  reason TEXT NOT NULL,
  confidence TEXT NOT NULL,
  before_canonical JSONB NOT NULL,
  before_duplicate JSONB NOT NULL,
  planned_canonical JSONB NOT NULL,
  applied_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_found_people_merge_audit_canonical_id
  ON found_people_merge_audit (canonical_id);

CREATE INDEX IF NOT EXISTS idx_found_people_merge_audit_duplicate_id
  ON found_people_merge_audit (duplicate_id);
