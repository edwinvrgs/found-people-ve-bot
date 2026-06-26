# Found People Venezuela Bot

[![CI](https://github.com/edwinvrgs/found-people-ve-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/edwinvrgs/found-people-ve-bot/actions/workflows/ci.yml)

Telegram bot and public API for consulting people reported as found or located after the June 24, 2026 earthquakes in Venezuela.

> This is an information-discovery tool, not an official registry. Always verify critical information with the linked source or with official/local responders.

- Bot: <https://t.me/encontrados_ve_bot>
- Public API: <https://bot-production-ed0b.up.railway.app>
- Source code: <https://github.com/edwinvrgs/found-people-ve-bot>

## Data sources and credits

This project centralizes searchable, source-linked records. Credit for the underlying public data belongs to the people and projects gathering, transcribing, publishing, and verifying information during the emergency.

Current sources:

- <https://github.com/ecrespo/OCR-data_Terremoto_Venezuela_24062026>
- <https://venezuelatebusca.com/>
- <https://desaparecidosterremotovenezuela.com/>
- Citizen reports submitted through the Telegram bot
- External reports submitted through the authenticated public API

The scraper also uses <https://venezuela.tiltely.com/> as a source directory. Links that are not structured found/localized-person sources are intentionally skipped.

## Features

- Telegram search by name or Venezuelan ID number.
- Public read API for list/search integrations.
- Authenticated API for external found-person reports.
- Internal/manual ingestion endpoint.
- Public-source scraper and Postgres upsert pipeline.
- Privacy-safe analytics and structured logging.

## Tech stack

- Node.js 22+, TypeScript, ESM
- Fastify
- Zod
- Railway Postgres
- Prisma schema/migrations
- Pino logs
- PostHog analytics
- Node test runner via `tsx --test`

## API

```txt
GET    /health
GET    /api/people?page=1&pageSize=5
GET    /api/v1/found-people?page=1&pageSize=10&q=Maria
POST   /api/v1/found-people/reports
POST   /api/ingest
DELETE /api/people
POST   /telegram/webhook
```

Use `/api/v1/found-people` for external search integrations. `/api/people` remains for compatibility/internal listing.

### Search/list found people

```http
GET /api/v1/found-people?page=1&pageSize=10
GET /api/v1/found-people?name=Maria
GET /api/v1/found-people?documentId=V12345678
GET /api/v1/found-people?q=maria+perez
```

Query parameters:

- `name`: partial, case-insensitive full-name search.
- `documentId`: Venezuelan ID search; formats like `V12345678` are normalized to digits.
- `q`: full search across name and cédula.
- `page` / `pageSize`: pagination; max page `500`, max page size `100`.

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

Only `verified` and `citizen_report` records are public. `needs_review` and `removed` records are hidden.

### Report a found person

```http
POST /api/v1/found-people/reports
Authorization: Bearer $EXTERNAL_API_SECRET
Content-Type: application/json
Idempotency-Key: optional-stable-report-id
```

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

External reports are stored as `citizen_report`, rate-limited, validated with a strict schema, and sent to the admin for review.

## Telegram commands

- `/ayuda` — show help.
- `/buscar Nombre Apellido` — search by name.
- `/buscar V12345678` — search by cédula.
- `/lista` — show paginated list.
- `/reportar` — start guided found-person report.
- `/fuentes` — show sources and limitations.
- `/sugerencia` — send feedback to admin.
- `/cancelar` — cancel pending flow.

Free-text messages are treated as searches.

Admin-only commands: `/admin_stats`, `/admin_recent`, `/admin_digest`, `/admin_verify`, `/admin_review`, `/admin_hide`, `/admin_delete`, `/admin_help`.

## Ingestion

```bash
npm run ingest:found-people            # dry-run; writes artifact only
npm run ingest:found-people -- --write # scrape and upsert into database
```

The scraper ingests found/localized sources directly from the known source URLs, paginates safely, extracts `documentId` when available, masks public document references in `relevantInfo`, and emits aggregate-only analytics. It does not depend on the Tiltely index page to discover upstream sources.

SocialCrawl ingestion is disabled by default. To run it intentionally, set `FOUND_PEOPLE_SOCIALCRAWL_ENABLED=true`; provider calls are bounded by `FOUND_PEOPLE_PROVIDER_TIMEOUT_MS`.

Manual ingestion remains available through `POST /api/ingest` with `INGEST_SECRET`.

## Development

```bash
npm ci
npm run db:validate
npm run typecheck
npm test
npm run build
npm run security:audit
```

Run locally:

```bash
DATABASE_URL='postgresql://user:pass@localhost:5432/found_people' \
INGEST_SECRET='dev-ingest-secret' \
EXTERNAL_API_SECRET='dev-external-secret' \
TELEGRAM_WEBHOOK_SECRET='dev-telegram-secret' \
PUBLIC_BASE_URL='http://localhost:3000' \
npm run dev
```

Required PostgreSQL extensions:

- `pgcrypto`
- `pg_trgm`
- `unaccent`

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

Configure Telegram webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$PUBLIC_BASE_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## Privacy and safety

- Do not log or expose names, cédulas, message text, tokens, raw payloads, or private records unnecessarily.
- Public records stay source-linked for verification.
- Public document references should be masked in user-visible text.
- Analytics use aggregate counts, buckets, and hashed identifiers.
- Telegram webhook responses should stay fast; long work should not block the acknowledgement.

## CI

GitHub Actions runs:

- Prisma schema validation
- Typecheck
- Smoke tests
- Build
- Production dependency audit

## Contributing

Before opening a PR:

1. Keep changes focused.
2. Avoid secrets or sensitive data.
3. Add/update tests for bot, API, ingestion, parsing, validation, or privacy-sensitive behavior.
4. Run the relevant checks.
5. Explain what changed, why, how it was verified, and any data/privacy impact.

Source-related changes should include public links and explain why they represent found/localized-person records.

## Open-source readiness

Still recommended before broader contributor activity:

- License file
- `CONTRIBUTING.md`
- Security reporting policy
- More route/service tests

Until a license is added, do not assume reuse rights beyond normal GitHub viewing/forking behavior.
