import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import type { FoundPerson, FoundPersonExternal, FoundPersonWithMetadata } from "../db.js";

type CountRow = { count: bigint | number | string };

export type UpsertPersonInput = {
  fullName: string;
  relevantInfo?: string | null;
  sourceUrl: string;
  sourceHash?: string;
  documentId?: string | null;
  raw?: Record<string, unknown>;
};

export async function listPeople(page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    prisma.$queryRaw<FoundPerson[]>`
      SELECT ${selectColumnsSql()} FROM found_people
      ORDER BY lower(full_name) ASC, source_url ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    prisma.foundPerson.count(),
  ]);

  return pageResult(items, page, pageSize, total);
}

export async function searchPeople(search: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const nameQuery = `%${search}%`;
  const documentDigits = normalizeDocumentDigits(search);
  const documentQuery = documentDigits ? `%${documentDigits}%` : null;
  const where = searchWhereSql(nameQuery, documentQuery);
  const [items, total] = await Promise.all([
    prisma.$queryRaw<FoundPerson[]>`
      SELECT ${selectColumnsSql()} FROM found_people
      WHERE ${where}
      ORDER BY lower(full_name) ASC, source_url ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*) AS count FROM found_people WHERE ${where}`,
  ]);

  return pageResult(items, page, pageSize, countValue(total));
}

export function normalizeDocumentDigits(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 5 ? digits : null;
}

export function normalizeDocumentId(value: string | null | undefined) {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 9 ? digits : null;
}

function searchWhereSql(nameQuery: string, documentQuery: string | null) {
  return Prisma.sql`(
      unaccent(lower(full_name)) ILIKE unaccent(lower(${nameQuery}))
      OR (
        ${documentQuery}::text IS NOT NULL
        AND document_id LIKE ${documentQuery}
      )
    )`;
}

export async function upsertPeople(people: UpsertPersonInput[]) {
  const rows: FoundPerson[] = [];

  for (const person of people) {
    const hash = person.sourceHash ?? await sha256(`${person.sourceUrl}:${person.fullName}`);
    const documentId = normalizeDocumentId(person.documentId);
    const existing = await findExistingIngestMatch(hash, documentId, person.sourceUrl);

    if (existing) {
      const enriched = enrichExistingPerson(existing, person, { hash, documentId });
      const [row] = await prisma.$queryRaw<FoundPerson[]>`
        UPDATE found_people SET
          full_name = ${enriched.fullName},
          relevant_info = ${enriched.relevantInfo},
          document_id = ${enriched.documentId},
          source_url = ${enriched.sourceUrl},
          raw = ${JSON.stringify(enriched.raw)}::jsonb,
          updated_at = now()
        WHERE id = ${existing.id}::uuid
        RETURNING ${selectColumnsSql()}`;
      rows.push(row);
      continue;
    }

    const [row] = await prisma.$queryRaw<FoundPerson[]>`
      INSERT INTO found_people (full_name, relevant_info, document_id, source_url, source_hash, raw)
      VALUES (${person.fullName}, ${person.relevantInfo ?? null}, ${documentId}, ${person.sourceUrl}, ${hash}, ${JSON.stringify(person.raw ?? {})}::jsonb)
      ON CONFLICT (source_hash) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        relevant_info = EXCLUDED.relevant_info,
        document_id = COALESCE(EXCLUDED.document_id, found_people.document_id),
        source_url = EXCLUDED.source_url,
        raw = EXCLUDED.raw,
        updated_at = now()
      RETURNING ${selectColumnsSql()}`;
    rows.push(row);
  }

  return rows;
}

type ExistingIngestPerson = FoundPerson & {
  documentId: string | null;
  sourceHash: string;
  raw: Prisma.JsonValue;
};

type IngestMatchInput = {
  hash: string;
  documentId: string | null;
};

type EnrichedPerson = {
  fullName: string;
  relevantInfo: string | null;
  documentId: string | null;
  sourceUrl: string;
  raw: Record<string, unknown>;
};

async function findExistingIngestMatch(sourceHash: string, documentId: string | null, sourceUrl: string) {
  const matches = await prisma.$queryRaw<ExistingIngestPerson[]>`
    SELECT ${selectColumnsSql()},
           document_id AS "documentId",
           source_hash AS "sourceHash",
           raw AS "raw"
    FROM found_people
    WHERE source_hash = ${sourceHash}
       OR (${documentId}::text IS NOT NULL AND document_id = ${documentId})
       OR source_url = ${sourceUrl}
    ORDER BY CASE
      WHEN source_hash = ${sourceHash} THEN 1
      WHEN ${documentId}::text IS NOT NULL AND document_id = ${documentId} THEN 2
      WHEN source_url = ${sourceUrl} THEN 3
      ELSE 4
    END,
    updated_at DESC
    LIMIT 1`;
  return matches[0] ?? null;
}

export function enrichExistingPerson(existing: ExistingIngestPerson, incoming: UpsertPersonInput, match: IngestMatchInput): EnrichedPerson {
  const incomingInfo = incoming.relevantInfo ?? null;
  const documentId = existing.documentId ?? match.documentId;
  const sourceUrl = existing.sourceHash === match.hash || existing.sourceUrl === incoming.sourceUrl ? incoming.sourceUrl : existing.sourceUrl;

  return {
    fullName: chooseBetterName(existing.fullName, incoming.fullName),
    relevantInfo: mergeRelevantInfo(existing.relevantInfo, incomingInfo),
    documentId,
    sourceUrl,
    raw: mergeIngestionRaw(existing.raw, incoming.raw ?? {}, {
      sourceHash: match.hash,
      sourceUrl: incoming.sourceUrl,
      documentId: match.documentId,
      matchedBy: existing.sourceHash === match.hash ? "source_hash" : existing.documentId && match.documentId && existing.documentId === match.documentId ? "document_id" : "source_url",
    }),
  };
}

function chooseBetterName(existing: string, incoming: string) {
  const normalizedExisting = existing.replace(/\s+/g, " ").trim();
  const normalizedIncoming = incoming.replace(/\s+/g, " ").trim();
  if (!normalizedIncoming) return normalizedExisting;
  if (!normalizedExisting) return normalizedIncoming;
  return normalizedIncoming.length > normalizedExisting.length ? normalizedIncoming : normalizedExisting;
}

function mergeRelevantInfo(existing: string | null, incoming: string | null) {
  const current = existing?.trim() || null;
  const next = incoming?.trim() || null;
  if (!current) return next;
  if (!next) return current;
  if (current.includes(next)) return current;
  if (next.includes(current)) return next;
  return next.length > current.length ? next : current;
}

function mergeIngestionRaw(existingRaw: Prisma.JsonValue, incomingRaw: Record<string, unknown>, source: { sourceHash: string; sourceUrl: string; documentId: string | null; matchedBy: string }) {
  const existing: Record<string, unknown> = isRecord(existingRaw) ? existingRaw : {};
  const previousSources: Record<string, unknown>[] = Array.isArray(existing.ingestionSources) ? existing.ingestionSources.filter(isRecord) : [];
  const sourceEntry = {
    sourceHash: source.sourceHash,
    sourceUrl: source.sourceUrl,
    documentId: source.documentId,
    matchedBy: source.matchedBy,
    lastSeenAt: new Date().toISOString(),
  };
  const dedupedSources = [sourceEntry, ...previousSources.filter((item) => item.sourceHash !== source.sourceHash)].slice(0, 20);

  return {
    ...existing,
    latestIngestion: incomingRaw,
    ingestionSources: dedupedSources,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function deletePersonBySourceUrl(sourceUrl: string) {
  return prisma.$queryRaw<FoundPerson[]>`
    DELETE FROM found_people WHERE source_url = ${sourceUrl}
    RETURNING ${selectColumnsSql()}`;
}

export async function deletePersonById(id: string) {
  return prisma.$queryRaw<FoundPerson[]>`
    DELETE FROM found_people WHERE id = ${id}::uuid
    RETURNING ${selectColumnsSql()}`;
}

export async function getFoundPeopleStats() {
  const total = await prisma.foundPerson.count();
  const metrics = await getBotMetrics();
  return { total, metrics };
}

export async function getPersonById(id: string) {
  const rows = await prisma.$queryRaw<FoundPersonWithMetadata[]>`
    SELECT ${selectColumnsSql()},
           created_at AS "createdAt",
           updated_at AS "updatedAt",
           raw->>'provider' AS provider
    FROM found_people
    WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

export async function incrementMetric(name: string, amount = 1) {
  await prisma.$executeRaw`
    INSERT INTO bot_metrics (name, value)
    VALUES (${name}, ${amount})
    ON CONFLICT (name) DO UPDATE SET value = bot_metrics.value + EXCLUDED.value, updated_at = now()`;
}

export async function getBotMetrics() {
  const result = await prisma.botMetric.findMany({ orderBy: { name: "asc" } });
  return Object.fromEntries(result.map((row) => [row.name, Number(row.value)]));
}

export async function listPeopleExternal(page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    prisma.$queryRaw<FoundPersonExternal[]>`
      SELECT ${selectColumnsExternalSql()} FROM found_people
      ORDER BY lower(full_name) ASC, source_url ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    prisma.foundPerson.count(),
  ]);
  return pageResult(items, page, pageSize, total);
}

export async function searchPeopleExternal(search: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const nameQuery = `%${search}%`;
  const documentDigits = normalizeDocumentDigits(search);
  const documentQuery = documentDigits ? `%${documentDigits}%` : null;
  const where = Prisma.sql`(
      unaccent(lower(full_name)) ILIKE unaccent(lower(${nameQuery}))
      OR (${documentQuery}::text IS NOT NULL AND document_id LIKE ${documentQuery})
    )`;
  const [items, total] = await Promise.all([
    prisma.$queryRaw<FoundPersonExternal[]>`
      SELECT ${selectColumnsExternalSql()} FROM found_people
      WHERE ${where}
      ORDER BY lower(full_name) ASC, source_url ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    prisma.$queryRaw<CountRow[]>`SELECT count(*) AS count FROM found_people WHERE ${where}`,
  ]);
  return pageResult(items, page, pageSize, countValue(total));
}

export async function searchPeopleByName(name: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const nameQuery = `%${name}%`;
  const where = Prisma.sql`unaccent(lower(full_name)) ILIKE unaccent(lower(${nameQuery}))`;
  const [items, total] = await Promise.all([
    prisma.$queryRaw<FoundPersonExternal[]>`
      SELECT ${selectColumnsExternalSql()} FROM found_people
      WHERE ${where}
      ORDER BY lower(full_name) ASC, source_url ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    prisma.$queryRaw<CountRow[]>`SELECT count(*) AS count FROM found_people WHERE ${where}`,
  ]);
  return pageResult(items, page, pageSize, countValue(total));
}

export async function searchPeopleByDocument(digits: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const documentQuery = `%${digits}%`;
  const where = Prisma.sql`document_id LIKE ${documentQuery}`;
  const [items, total] = await Promise.all([
    prisma.$queryRaw<FoundPersonExternal[]>`
      SELECT ${selectColumnsExternalSql()} FROM found_people
      WHERE ${where}
      ORDER BY lower(full_name) ASC, source_url ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    prisma.$queryRaw<CountRow[]>`SELECT count(*) AS count FROM found_people WHERE ${where}`,
  ]);
  return pageResult(items, page, pageSize, countValue(total));
}

function selectColumnsSql() {
  return Prisma.sql`id,
    full_name AS "fullName",
    relevant_info AS "relevantInfo",
    source_url AS "sourceUrl"`;
}

function selectColumnsExternalSql() {
  return Prisma.sql`id,
    full_name AS "fullName",
    relevant_info AS "relevantInfo",
    source_url AS "sourceUrl",
    document_id AS "documentId"`;
}

function pageResult<T>(items: T[], page: number, pageSize: number, total: number) {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function countValue(rows: CountRow[]) {
  return Number(rows[0]?.count ?? 0);
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
