import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeDocumentId, sanitizeRelevantInfo } from "./sanitize.js";
import type { RejectedSearchCandidate, SearchCandidateInput, SearchProviderResult } from "./search-provider.js";

export const DEFAULT_OUTPUT_DIR = "artifacts/found-people-ingest";
export const DEFAULT_DB_BATCH_SIZE = 500;
export const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;

type SourceSummary = {
  candidates: number;
  accepted: number;
  skipped: number;
  withDocumentId: number;
};

type NormalizedPerson = {
  fullName: string;
  relevantInfo: string | null;
  sourceUrl: string;
  documentId: string | null;
  sourceHash: string;
  raw: Record<string, unknown>;
};

type SkippedPerson = NormalizedPerson & { reasons: string[] };

type IngestLogger = {
  info: (details: Record<string, unknown>, message?: string) => void;
  warn?: (details: Record<string, unknown>, message?: string) => void;
};

export type RunIngestionOptions = {
  queryLimit: number;
  write: boolean;
  outputDir: string;
  batchSize?: number;
  progressIntervalMs?: number;
  logger: IngestLogger;
  searchCandidates: (queryLimit: number) => Promise<SearchProviderResult>;
  ensureSchema?: () => Promise<void>;
  upsertPeople?: (people: NormalizedPerson[]) => Promise<unknown[]>;
};

export type IngestionReport = {
  ok: true;
  dryRun: boolean;
  wroteToDatabase: boolean;
  startedAt: string;
  finishedAt: string;
  queryLimit: number;
  counts: {
    candidates: number;
    accepted: number;
    skipped: number;
    rejectedByProvider: number;
    providerErrors: number;
    upserted: number;
  };
  sources: Record<string, SourceSummary>;
  providerErrors: string[];
  accepted: NormalizedPerson[];
  skipped: SkippedPerson[];
  rejectedByProvider: RejectedSearchCandidate[];
};

export async function runFoundPeopleIngest(options: RunIngestionOptions) {
  const startedAt = new Date();
  const batchSize = options.batchSize ?? envInt("FOUND_PEOPLE_DB_INGEST_BATCH_SIZE", DEFAULT_DB_BATCH_SIZE);
  const progressIntervalMs = options.progressIntervalMs ?? envInt("FOUND_PEOPLE_INGEST_PROGRESS_INTERVAL_MS", DEFAULT_PROGRESS_INTERVAL_MS);
  const logger = options.logger;

  logger.info({
    event: "ingest_started",
    dryRun: !options.write,
    write: options.write,
    queryLimit: options.queryLimit,
    outputDir: options.outputDir,
    batchSize,
    progressIntervalMs,
  }, "Found people ingest started");

  if (options.write) {
    if (!options.ensureSchema || !options.upsertPeople) throw new Error("write mode requires ensureSchema and upsertPeople");
    logger.info({ event: "ingest_schema_ensure_started" }, "Ensuring database schema before ingest");
    await options.ensureSchema();
    logger.info({ event: "ingest_schema_ensure_completed" }, "Database schema ready for ingest");
  }

  logger.info({ event: "ingest_candidate_search_started", queryLimit: options.queryLimit }, "Searching found-person candidates");
  const result = await withProgressLog(
    () => options.searchCandidates(options.queryLimit),
    { logger, event: "ingest_candidate_search_waiting", message: "Still searching found-person candidates", progressIntervalMs },
  );
  logger.info({
    event: "ingest_candidate_search_completed",
    candidates: result.candidates.length,
    providerErrors: result.errors.length,
    rejectedByProvider: result.rejected?.length ?? 0,
  }, "Found-person candidate search completed");

  const accepted: NormalizedPerson[] = [];
  const skipped: SkippedPerson[] = [];
  const sources: Record<string, SourceSummary> = {};

  for (const candidate of result.candidates) {
    const source = sourceName(candidate.raw);
    incrementSourceSummary(sources, source, "candidates");

    const normalized = normalizeCandidate(candidate);
    if (normalized.accepted) {
      accepted.push(normalized.person);
      incrementSourceSummary(sources, source, "accepted");
      if (normalized.person.documentId) incrementSourceSummary(sources, source, "withDocumentId");
    } else {
      skipped.push({ ...normalized.person, reasons: normalized.reasons });
      incrementSourceSummary(sources, source, "skipped");
    }
  }

  logger.info({
    event: "ingest_candidates_normalized",
    accepted: accepted.length,
    skipped: skipped.length,
    withDocumentId: accepted.filter((person) => person.documentId).length,
    sources,
  }, "Found-person candidates normalized");

  const upserted = options.write && accepted.length > 0
    ? await upsertInBatches(accepted, options.upsertPeople!, { batchSize, logger, progressIntervalMs })
    : 0;

  const finishedAt = new Date();
  mkdirSync(options.outputDir, { recursive: true });
  const filename = `ingest-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  const outputPath = path.join(options.outputDir, filename);
  const report: IngestionReport = {
    ok: true,
    dryRun: !options.write,
    wroteToDatabase: options.write,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    queryLimit: options.queryLimit,
    counts: {
      candidates: result.candidates.length,
      accepted: accepted.length,
      skipped: skipped.length,
      rejectedByProvider: result.rejected?.length ?? 0,
      providerErrors: result.errors.length,
      upserted,
    },
    sources,
    providerErrors: result.errors,
    accepted,
    skipped,
    rejectedByProvider: result.rejected ?? [],
  };

  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  logger.info({ event: "ingest_report_written", outputPath, counts: report.counts }, "Found people ingest report written");
  logger.info({
    event: "ingest_completed",
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    outputPath,
    counts: report.counts,
    sources,
  }, "Found people ingest completed");

  return { outputPath, report };
}

function normalizeCandidate(candidate: SearchCandidateInput) {
  const fullName = candidate.fullName.replace(/\s+/g, " ").trim();
  const relevantInfo = sanitizeRelevantInfo(candidate.relevantInfo);
  const documentId = normalizeDocumentId(candidate.documentId);
  const reasons: string[] = [];

  if (fullName.length < 2) reasons.push("name_too_short");
  if (fullName.length > 200) reasons.push("name_too_long");
  if (!/^https?:\/\//i.test(candidate.sourceUrl)) reasons.push("invalid_source_url");

  return {
    accepted: reasons.length === 0,
    reasons,
    person: {
      fullName,
      relevantInfo,
      sourceUrl: candidate.sourceUrl,
      documentId,
      sourceHash: candidate.sourceHash,
      raw: candidate.raw ?? {},
    },
  };
}

async function upsertInBatches(people: NormalizedPerson[], upsertPeople: (people: NormalizedPerson[]) => Promise<unknown[]>, options: { batchSize: number; progressIntervalMs: number; logger: IngestLogger }) {
  let upserted = 0;
  options.logger.info({ event: "ingest_db_upsert_started", total: people.length, batchSize: options.batchSize }, "Writing found-person candidates to database");

  for (let index = 0; index < people.length; index += options.batchSize) {
    const batch = people.slice(index, index + options.batchSize);
    const batchNumber = Math.floor(index / options.batchSize) + 1;
    const totalBatches = Math.ceil(people.length / options.batchSize);
    options.logger.info({ event: "ingest_db_batch_started", batchNumber, totalBatches, from: index + 1, to: index + batch.length, total: people.length }, "Writing found-person ingest batch");
    const rows = await withProgressLog(
      () => upsertPeople(batch),
      { logger: options.logger, event: "ingest_db_batch_waiting", message: "Still writing found-person ingest batch", progressIntervalMs: options.progressIntervalMs, details: { batchNumber, totalBatches, from: index + 1, to: index + batch.length, total: people.length } },
    );
    upserted += rows.length;
    options.logger.info({ event: "ingest_db_batch_completed", batchNumber, totalBatches, batchRows: rows.length, upserted, total: people.length }, "Found-person ingest batch written");
  }

  options.logger.info({ event: "ingest_db_upsert_completed", upserted, total: people.length }, "Found-person database write completed");
  return upserted;
}

async function withProgressLog<T>(operation: () => Promise<T>, options: { logger: IngestLogger; event: string; message: string; progressIntervalMs: number; details?: Record<string, unknown> }) {
  const startedAt = Date.now();
  const interval = options.progressIntervalMs > 0
    ? setInterval(() => {
      options.logger.info({ event: options.event, elapsedMs: Date.now() - startedAt, ...(options.details ?? {}) }, options.message);
    }, options.progressIntervalMs)
    : null;
  interval?.unref();
  try {
    return await operation();
  } finally {
    if (interval) clearInterval(interval);
  }
}

function sourceName(raw: Record<string, unknown> | undefined) {
  const source = raw?.source ?? raw?.provider;
  return typeof source === "string" && source.trim() ? source.trim().slice(0, 80) : "unknown";
}

function emptySourceSummary(): SourceSummary {
  return { candidates: 0, accepted: 0, skipped: 0, withDocumentId: 0 };
}

function incrementSourceSummary(sources: Record<string, SourceSummary>, source: string, field: keyof SourceSummary) {
  sources[source] ??= emptySourceSummary();
  sources[source][field] += 1;
}

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function providerErrorSource(error: string) {
  const match = error.match(/^([a-zA-Z0-9_.-]+)\s+(?:page|:)/);
  return match?.[1] ?? "unknown";
}

export function countProviderErrorsBySource(errors: string[]) {
  const counts: Record<string, number> = {};
  for (const error of errors) {
    const source = providerErrorSource(error);
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}
