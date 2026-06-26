# Backend architecture audit

Date: 2026-06-26

## Executive summary

The bot backend is reliable enough for the emergency MVP, but the repo is becoming public and the backend should be split into clearer layers before more contributors build on it. The highest-risk area is not a single bug; it is the amount of responsibility concentrated in `src/server.ts` and the fact that database DDL currently lives in application boot code.

This PR intentionally keeps behavior changes small. It adds the foundation for safer future refactors:

- a versioned database migration that captures the current production schema;
- a Prisma schema so the database model is reviewable and can later back generated client queries;
- structured logging through `pino`;
- CI for Prisma schema validation, typecheck, and build.

## Current architecture risks

### 1. HTTP server monolith

`src/server.ts` currently mixes:

- HTTP route dispatch;
- public API validation;
- external report creation;
- Telegram webhook handling;
- Telegram conversation state;
- admin commands;
- formatting helpers;
- analytics;
- auth/rate-limit/error handling.

That made sense for a fast MVP, but it will slow down reviews and increase conflict risk as the repo grows.

Recommended split, in order:

```txt
src/config/env.ts
src/http/errors.ts
src/http/routes/public-api.ts
src/http/routes/admin-api.ts
src/telegram/handlers.ts
src/telegram/formatters.ts
src/services/found-people.ts
src/services/reports.ts
src/repositories/found-people.ts
```

### 2. Runtime schema management

`ensureSchema()` creates extensions, tables, constraints, indexes, and legacy column migrations at runtime. This is convenient, but risky in a public/stable deployment:

- application boot can fail if the app role loses DDL privileges;
- schema changes are hard to review and roll back;
- concurrent deploys can race on DDL;
- there is no migration history.

This PR adds a first migration under `prisma/migrations/.../migration.sql` that mirrors the current schema. The recommended deployment flow after this lands is:

```bash
npm run db:migrate
npm run build
npm run start
```

For one deploy, keep `ensureSchema()` as a compatibility safety net. Once Railway migration execution is confirmed, remove runtime DDL from app boot in a follow-up PR.

### 3. Prisma adoption sequencing

The repo should not switch all queries to Prisma in the same PR as framework/router refactoring. The current raw `pg` queries are parameterized and clear, while the schema has PostgreSQL-specific pieces that Prisma still needs raw SQL migrations for:

- `pg_trgm` extension;
- `unaccent` extension;
- expression index on `lower(full_name)`;
- partial index on `document_id`;
- check constraints.

Recommended path:

1. Land schema/migration foundation.
2. Extract repository/service boundaries around current DB calls.
3. Convert repository methods to Prisma where it fits.
4. Keep raw SQL for search paths that need `unaccent`, trigram, or specialized indexes.

### 4. Framework choice

A TypeScript framework is appropriate, but the migration should be separate from database changes. Recommended choice: **Fastify**.

Why Fastify:

- low overhead;
- first-class TypeScript ecosystem;
- request lifecycle hooks;
- good schema/validation integration;
- built-in request IDs and logging integration;
- easier migration from the current Node HTTP server than NestJS.

Recommended Fastify PR scope:

- add Fastify app factory;
- port public API routes first;
- keep Telegram webhook route behavior identical;
- add request logging and centralized error response;
- do not change persistence in the same PR.

### 5. Logging and observability

Before this PR, server errors used `console.error`, losing stack/request context. This PR adds `pino` and uses structured logs for server startup, request failures, analytics failures, and ingest failures.

Recommended follow-up:

- add request IDs;
- log method/path/status/duration;
- never log tokens, raw search text, cédulas, locations, notes, or Telegram secret headers;
- map internal errors to stable public error responses.

### 6. Public repo hygiene

Recommended additions before broader public contributor activity:

- `LICENSE`;
- `CONTRIBUTING.md`;
- `.env.example`;
- route/service tests for public API and report creation;
- decision record for privacy/analytics policy.

## Open PR context note

PR #1 was merged into `main`. PR #2 was marked merged, but its base branch was `pr-1-safe-search-param`, not `main`, so those error-handling changes are not currently on `main`. Treat that as a separate cleanup item and avoid mixing it with the architecture foundation PR.
