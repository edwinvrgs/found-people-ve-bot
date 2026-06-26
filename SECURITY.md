# Security Policy

## Reporting a vulnerability

Please do not open public issues for security vulnerabilities.

Report suspected vulnerabilities privately to the maintainer:

- GitHub Security Advisory, if available for this repository
- Or contact Edwin Vargas through the maintainer profile on GitHub

Include as much detail as you safely can:

- affected endpoint, command, or workflow
- impact and prerequisites
- reproduction steps
- relevant logs or screenshots with secrets and personal data redacted
- suggested mitigation, if known

## Scope

Security-sensitive areas include:

- Telegram webhook authentication
- admin and ingestion endpoints
- external report API authentication
- rate limiting and abuse prevention
- database writes and migrations
- handling of personal data, document IDs, and citizen reports
- secrets in logs, examples, CI, or deployment configuration

## Response expectations

The maintainer will triage reports as soon as practical. Emergency-response context may affect priority, but reports involving credential exposure, unauthorized writes, privacy leaks, or production availability should be treated as high priority.

## Safe harbor

Good-faith research is welcome when it avoids privacy harm, data destruction, persistence, service disruption, and access to data beyond what is necessary to demonstrate the issue.
