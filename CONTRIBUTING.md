# Contributing

Thanks for helping improve Found People Venezuela Bot.

This project supports emergency information discovery. Please treat data quality, privacy, and operational safety as first-class concerns.

## Before you start

- Open an issue for larger changes before investing significant time.
- Keep changes focused and easy to review.
- Do not commit secrets, private credentials, production database URLs, or private personal data.
- Avoid adding new third-party services unless they are necessary and documented.

## Local setup

```bash
npm ci
cp .env.example .env
npm run db:generate
```

Set local environment variables as needed. Use test or local databases only.

## Development checks

Run these before opening a PR:

```bash
npm run typecheck
DATABASE_URL=postgresql://user:pass@localhost:5432/db npm run db:validate
npm run test:smoke
npm run security:audit
```

If your change touches database behavior, also validate migrations against a disposable database.

## Pull requests

A good PR should include:

- a short problem statement
- a concise summary of the fix
- tests for new behavior or regressions
- manual verification notes when relevant
- screenshots or API examples for user-facing changes

## Data and privacy guidelines

- Public responses must not expose full document IDs unnecessarily.
- Prefer source-linked records over copied free-form personal details.
- Keep ingestion logs aggregate or operational; avoid logging sensitive payloads.
- Be careful with minors, medical details, and OCR-derived data.

## Code style

- TypeScript ESM.
- Prefer small pure functions where practical.
- Keep route handlers thin; put reusable behavior in services/repositories.
- Add tests near the code they cover using Node's built-in test runner.

## License

By contributing, you agree that your contributions are licensed under the repository license.
