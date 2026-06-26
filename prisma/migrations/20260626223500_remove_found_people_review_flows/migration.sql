-- Remove the review/status workflow for now.
-- Keep previously verified and citizen_report records as regular public records.
-- Drop pending/hidden records before removing status so they do not become public accidentally.
-- Merge audit rows can reference pending/hidden records, so remove those audit references first.
DELETE FROM found_people_merge_audit
WHERE canonical_id IN (SELECT id FROM found_people WHERE status IN ('needs_review', 'removed'))
   OR duplicate_id IN (SELECT id FROM found_people WHERE status IN ('needs_review', 'removed'));

DELETE FROM found_people
WHERE status IN ('needs_review', 'removed');

DROP INDEX IF EXISTS idx_found_people_status;
ALTER TABLE found_people DROP CONSTRAINT IF EXISTS found_people_status_check;
ALTER TABLE found_people DROP COLUMN IF EXISTS status;
