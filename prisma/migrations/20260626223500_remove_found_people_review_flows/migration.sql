-- Remove the review/status workflow for now.
-- Keep previously verified and citizen_report records as regular public records.
-- Drop pending/hidden records before removing status so they do not become public accidentally.
DELETE FROM found_people
WHERE status IN ('needs_review', 'removed');

DROP INDEX IF EXISTS idx_found_people_status;
ALTER TABLE found_people DROP CONSTRAINT IF EXISTS found_people_status_check;
ALTER TABLE found_people DROP COLUMN IF EXISTS status;
