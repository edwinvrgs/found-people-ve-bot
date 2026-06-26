# Found People Venezuela Bot

[![CI](https://github.com/edwinvrgs/found-people-ve-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/edwinvrgs/found-people-ve-bot/actions/workflows/ci.yml)

Telegram bot and public API for consulting and reporting people found or located after the June 24, 2026 earthquakes in Venezuela.

The project collects public, source-linked records from public lists, citizen reports, and transcriptions of handwritten medical-attention lists. The goal is to help relatives, volunteers, and community members find leads faster while keeping every public record tied to a source that can be independently checked.

> Important: this project is an information-discovery tool, not an official registry. Always verify critical information with the linked source or with official/local responders before taking action.

- Public bot: <https://t.me/encontrados_ve_bot>
- Public API base URL: <https://bot-production-ed0b.up.railway.app>
- Main medical-transcription source: <https://github.com/ecrespo/OCR-data_Terremoto_Venezuela_24062026>

## Credits and current data sources

This project only centralizes searchable, source-linked records. Credit for the underlying public data belongs to the people and projects gathering, transcribing, publishing, and verifying information during the emergency.

Current sources:

- Public OCR/transcribed medical lists: <https://github.com/ecrespo/OCR-data_Terremoto_Venezuela_24062026>
- VenezuelaTeBusca: <https://venezuelatebusca.com/>
- Desaparecidos Terremoto Venezuela: <https://desaparecidosterremotovenezuela.com/>
- Citizen reports submitted through the Telegram bot
- External reports submitted through the authenticated public API

The scraper also checks the Tiltely Venezuela catalog as a source directory:

- <https://venezuela.tiltely.com/>

Some linked resources are intentionally not ingested when they are not structured found-person sources, for example donation pages, general emergency links, building-damage maps, or the bot itself.

## Repository status

This is an active emergency-response project. The codebase currently includes:

- Telegram bot webhook and flows
- Public read API
- Authenticated external report API
- Internal/manual ingestion endpoint
- Public-source scraper and direct Postgres upsert pipeline
- Railway Postgres persistence
- Prisma schema and SQL migrations for the current database shape
- Structured logging with `pino`
- GitHub Actions CI with separate validation, smoke-test, build, and production-dependency audit jobs

The backend is intentionally still small and dependency-light. See [`docs/architecture/backend-audit.md`](docs/architecture/backend-audit.md) for the current maintainability audit and the recommended refactor path.

## Tech stack

- Runtime: Node.js 22+
- Language: TypeScript / ESM
- HTTP: Node `http` server
- Validation: Zod
- Database: Railway Postgres
- Database migrations/schema: Prisma + SQL migrations
- Logging: Pino
- Analytics: PostHog server-side events
- Tests: Node test runner via `tsx --test`
- Deployment: Railway

## API overview

```txt
GET    /health
GET    /api/search?name=Maria&page=1&pageSize=5
GET    /api/people?page=1&pageSize=5
GET    /api/v1/found-people?page=1&pageSize=10&q=Maria
POST   /api/v1/found-people/reports
POST   /api/ingest
DELETE /api/people
POST   /telegram/webhook
```

Prefer `/api/v1/found-people` for external consumers. Older endpoints remain available for compatibility and internal workflows.

## External API v1

### List or search found people

```http
GET /api/v1/found-people?page=1&pageSize=10
GET /api/v1/found-people?name=Maria
GET /api/v1/found-people?documentId=V12345678
GET /api/v1/found-people?q=maria+perez
```

Query parameters:

- `name` — partial, case-insensitive match on full name only.
- `documentId` — match on cédula number; accepts any format (`V12345678`, `V-12.345.678`, etc.) and normalizes to digits server-side. Requires 6–9 digits after normalization.
- `q` — full search: partial, case-insensitive match on both name and cédula simultaneously.
- `page` / `pageSize` — pagination; max `pageSize` is 100.

Response:

```json
{
  "data": [
    {
      "id": "uuid",
      "fullName": "Maria Perez",
      "relevantInfo": "Hospital / shelter / public note",
      "sourceUrl": "https://example.com/source",
      "status": "verified",
      "documentId": "12345678"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 352,
    "totalPages": 36
  }
}
```

Public visibility rules:

- Only public-visible records are returned: `verified` and `citizen_report`. Records marked as `needs_review` or `removed`/hidden are excluded.
- `documentId` is returned as raw digits when present, or `null`.
- Maximum `page`: 500.
- Maximum `pageSize`: 100.
- Rate-limited by IP.
- Returned statuses: `verified`, `citizen_report`.
- Hidden statuses: `needs_review`, `removed`.
- `documentId` is never returned in public list/search responses.

Validation errors use stable English messages:

```json
{
  "error": "Invalid query parameters",
  "details": [
    {
      "field": "q",
      "code": "too_big",
      "message": "Search query must be at most 80 characters long"
    }
  ]
}
```

### Report a found person

```http
POST /api/v1/found-people/reports
Authorization: Bearer $EXTERNAL_API_SECRET
Content-Type: application/json
Idempotency-Key: optional-stable-report-id
```

Payload:

```json
{
  "fullName": "Maria Perez",
  "location": "La Carlota Shelter",
  "sourceUrl": "https://example.com/optional-source",
  "notes": "Optional additional information",
  "reporter": {
    "service": "service-name",
    "name": "optional name",
    "contact": "optional contact"
  }
}
```

`201` response:

```json
{
  "data": {
    "id": "uuid",
    "fullName": "Maria Perez",
    "relevantInfo": "External report — location: La Carlota Shelter",
    "sourceUrl": "https://example.com/optional-source",
    "status": "citizen_report"
  }
}
```

Safeguards:

- Uses `EXTERNAL_API_SECRET`, separate from internal ingestion secrets.
- External clients cannot choose `status`; reports are always stored as `citizen_report`.
- Hashing/idempotency is generated server-side.
- Strict JSON schema rejects unexpected fields.
- `sourceUrl`, when provided, must use `http` or `https`.
- Maximum body size: 256 KB.
- Validation errors return `400` with English field-level details.
- Invalid JSON returns `400`; oversized bodies return `413`.
- Rate-limited by IP and token.
- Notifies the admin for operational review.

## Telegram usage

- `/ayuda` shows the main options and commands.
- `/buscar Nombre Apellido` searches by name.
- `/buscar V12345678` searches by Venezuelan ID number; the search normalizes letters, dots, and hyphens.
- `/lista` shows the paginated list.
- `/reportar` starts a guided flow to report a found person. It also accepts `/reportar Full Name | Location | optional link`.
- `/fuentes` explains where the data comes from and its limitations.
- `/sugerencia` starts a flow to send feedback to the admin. It also accepts `/sugerencia message`.
- `/cancelar` cancels a pending operation.
- Any free-text message is treated as a name search.

## Admin commands

These commands only work from `TELEGRAM_ADMIN_CHAT_ID`:

- `/admin_stats` shows totals by status and metrics.
- `/admin_recent [n] [status]` shows the latest citizen reports, max 10.
- `/admin_digest` shows a quick digest.
- `/admin_verify id` marks a record as verified.
- `/admin_review id` marks a record as needs review.
- `/admin_hide id` hides a record without deleting it.
- `/admin_delete id-or-url` permanently deletes by ID or source URL.
- `/admin_help` shows admin help.

## Ingestion

The primary ingestion path runs inside this repo and writes directly to Postgres via `upsertPeople(...)`:

```bash
npm run ingest:found-people            # dry-run; writes an artifact only
npm run ingest:found-people -- --write # scrape and upsert into the bot database
```

The scraper:

- reads the Tiltely catalog as a source directory;
- ingests only found/localized upstream sources;
- paginates each source safely;
- extracts `documentId` when available;
- masks public document references in `relevantInfo`;
- emits `found_people_scrape_completed` in PostHog with aggregate counts only.

`POST /api/ingest` remains available for internal/manual ingestion and upserts records by `sourceHash`. If `sourceHash` is omitted, the backend generates one from `sourceUrl:fullName`.

Optional `documentId` stores a Venezuelan ID number as normalized digits for private exact/partial search. It is not returned by the public listing/search API. Public text should only include masked document references such as `cédula terminada en 1234`.

Manual ingestion example:

```bash
curl -X POST "$PUBLIC_BASE_URL/api/ingest" \
  -H "Authorization: Bearer $INGEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "people": [
      {
        "fullName": "Maria Perez",
        "relevantInfo": "Found at La Carlota shelter",
        "documentId": "12345678",
        "sourceUrl": "https://example.com/source"
      }
    ]
  }'
```

## Development

Requirements:

- Node.js 22+
- npm
- PostgreSQL connection for runtime/database work

Install dependencies:

```bash
npm ci
```

Useful scripts:

```bash
npm run typecheck       # TypeScript typecheck
npm run test:smoke      # smoke tests
npm run build           # compile TypeScript
npm run security:audit  # production dependency audit
npm run db:validate     # validate Prisma schema
npm run db:generate     # generate Prisma client
npm run db:migrate      # apply Prisma migrations
```

For local Prisma validation without a real database connection, use a placeholder URL:

```bash
DATABASE_URL='postgresql://user:pass@localhost:5432/found_people' npm run db:validate
```

Run the server locally:

```bash
DATABASE_URL='postgresql://user:pass@localhost:5432/found_people' \
INGEST_SECRET='dev-ingest-secret' \
EXTERNAL_API_SECRET='dev-external-secret' \
PUBLIC_BASE_URL='http://localhost:3000' \
npm run dev
```

## Database and migrations

The current database shape is captured in:

- `prisma/schema.prisma`
- `prisma/migrations/20260626130000_init_found_people/migration.sql`

The initial migration is a clean baseline for the current schema. Runtime `ensureSchema()` still exists as a compatibility safety net, but migrations should become the preferred deployment path.

Recommended production deploy flow:

```bash
npm run db:migrate
npm run build
npm run start
```

Required PostgreSQL extensions:

- `pgcrypto` for `gen_random_uuid()`
- `pg_trgm` for trigram search index support
- `unaccent` for accent-insensitive search

## Environment variables

```env
PORT=3000
DATABASE_URL=
PG_POOL_MAX=5
PUBLIC_BASE_URL=
INGEST_SECRET=
EXTERNAL_API_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ADMIN_CHAT_ID=
POSTHOG_API_KEY=
POSTHOG_HOST=https://us.i.posthog.com
ANALYTICS_HASH_SALT=
LOG_LEVEL=info
```

Production notes:

- `TELEGRAM_WEBHOOK_SECRET` must be configured before exposing the Telegram webhook.
- If `POSTHOG_API_KEY` is configured, production must also configure `ANALYTICS_HASH_SALT` or `TELEGRAM_WEBHOOK_SECRET` for stable hashing.
- `PUBLIC_BASE_URL` should be set in production so generated report URLs are valid.

## Configure the Telegram webhook

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$PUBLIC_BASE_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## Protected manual deletion

```bash
curl -X DELETE "$PUBLIC_BASE_URL/api/people" \
  -H "Authorization: Bearer $INGEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sourceUrl":"https://example.com/source"}'
```

## Analytics and privacy

The bot can send server-side events to PostHog when `POSTHOG_API_KEY` is configured.

Privacy principles:

- Telegram/public `/api/search` query text, locations, notes, URLs, tokens, and raw IDs are not sent.
- External list `q` is normalized, length-limited, character-restricted, and then sent only as validated search metadata.
- If Telegram provides a `username`, it is used as a readable `distinctId` (`telegram:@username`) and as the `telegramUsername` property in PostHog.
- If Telegram does not provide a `username`, the Telegram ID is hashed with `ANALYTICS_HASH_SALT` or `TELEGRAM_WEBHOOK_SECRET`.
- External client IPs/identifiers are only recorded as hashes when applicable.
- Public document references are masked in displayed text.

Official event taxonomy:

Telegram events:

- `message_received`: message received by the bot. Does not include message text.
- `telegram_command`: command used (`ayuda`, `buscar`, `lista`, `reportar`, etc.; admin commands keep English names).
- `search_performed`: Telegram search executed; includes length bucket, query type (`name`/`document`), and result count. Does not include the search text or ID number.
- `search_matched`: search returned at least one match; emitted for Telegram and public API searches. Includes surface, length bucket, query type, pagination, and counts. Does not include the search text, ID number, names, or source URLs.
- `list_viewed`: list viewed; includes page and counts.
- `citizen_report_created`: citizen report created from Telegram; only flags/buckets, no name, location, or source.
- `feedback_submitted`: feedback sent; only length bucket, not the content.
- `rate_limited`: rate limit applied to a message or callback.

External API / ingestion events:

- `found_people_scrape_completed`: internal scraper finished; includes aggregate totals, per-source counts, document-ID counts, duration, dry-run/write flag, and provider error counts. Does not include names, cédulas, URLs, raw records, or secrets.
- `search_matched`: public `/api/search` returned at least one match; uses a hashed client identifier and contains no query text or raw ID.
- `external_api_list_requested`: `GET /api/v1/found-people` usage; includes pagination/counts, hashed client ID, and validated `q` plus length bucket when present.
- `external_report_created`: report created through `POST /api/v1/found-people/reports`; only flags and hashed client ID.

Events outside the taxonomy:

- `openclaw_debug_event` and `openclaw_direct_capture_test` were one-off manual connectivity tests and are not part of the bot.
- No `openclaw_*` event should exist in production instrumentation.

`/health` returns `analytics: "configured" | "disabled"` to verify whether PostHog is active.

## Security and limits

- `POST /api/ingest` and `DELETE /api/people` require `Authorization: Bearer $INGEST_SECRET`.
- `POST /api/v1/found-people/reports` requires `Authorization: Bearer $EXTERNAL_API_SECRET`.
- Public endpoints and the webhook use in-memory rate limits.
- Maximum `pageSize`: 10.
- Maximum `page`: 500.
- Maximum JSON body size: 256 KB.
- Default Postgres pool size: `PG_POOL_MAX=5`.
- Structured logs redact common secret fields.

## CI

GitHub Actions runs these checks on pull requests and pushes to `main`:

- `Validate schema and types`
- `Smoke tests`
- `Build`
- `Production dependency audit`

The `Build` job depends on validation and smoke tests, so a broken schema, type error, or failing smoke test blocks the build check.

## Contributing

Contributions are welcome when they improve reliability, safety, privacy, or source coverage.

Before opening a pull request:

1. Keep changes focused and reviewable.
2. Avoid committing secrets, tokens, raw private records, or screenshots with sensitive data.
3. Add or update tests when changing parsing, validation, search, or ingestion logic.
4. Run the local checks:

   ```bash
   DATABASE_URL='postgresql://user:pass@localhost:5432/found_people' npm run db:validate
   npm run typecheck
   npm run test:smoke
   npm run build
   npm run security:audit
   ```

5. Describe:
   - what changed;
   - why it changed;
   - how it was validated;
   - any data/privacy implications.

For source-related changes, include links to public sources and explain why they represent found/localized-person records rather than general emergency information.

## Open-source readiness notes

This repository is public-facing but still evolving quickly. Before wider contributor activity, the project should add:

- a license file;
- a dedicated `CONTRIBUTING.md`;
- a security reporting policy;
- more route/service tests;
- further backend modularization as described in `docs/architecture/backend-audit.md`.

Until a license is added, do not assume reuse rights beyond normal GitHub viewing/forking behavior.
