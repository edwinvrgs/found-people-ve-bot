# Found People medallion ingest

The found-person ingest should not write scraped rows directly into the public canonical dataset. It follows a lightweight medallion model so weak signals never become automatic merges.

## Bronze: raw provider candidates

Bronze is the untrusted landing layer.

- Preserve raw provider payloads in reports and `raw.latestIngestion` metadata.
- Keep provider errors and provider-level rejected candidates in the ingest report.
- Do not infer identity from page/list URLs at this layer.

## Silver: normalized identity candidates

Silver turns provider rows into comparable candidates.

- Normalize names, relevant info, document IDs, source hashes, and source URL identity.
- Classify `source_url` as either:
  - `person_specific_source_url`: safe as an automatic identity key.
  - `shared_list_source_url`: only provenance, never an automatic identity key.
- Current person-specific URL patterns are centralized in `src/ingestion/source-identity.ts`:
  - `https://venezuelatebusca.com/...#record=...`
  - URLs with `?persona=...`
  - `/p/...` profile paths
  - GitHub line anchors like `#L123`

## Gold: canonical `found_people`

Gold is the public canonical dataset queried by the bot.

Automatic ingest matching is allowed only by strong keys:

1. `source_hash`
2. `document_id`
3. `person_specific_source_url`

These signals are manual-review only and must not auto-merge:

- shared/list `source_url` values such as `https://venezuelatebusca.com/?status=found&page=100`
- same normalized name
- similar name

When an incoming candidate matches an existing Gold row, the repository enriches the canonical row and stores ingestion provenance in `raw.ingestionSources`. Removed rows stay removed.

## Why this exists

A production dry-run found thousands of false automatic duplicates caused by shared VenezuelaTeBusca list-page URLs. The pipeline now treats those URLs as provenance only and centralizes URL identity classification so future sources cannot accidentally reintroduce that failure mode.
