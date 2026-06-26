import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { personSpecificSourceUrlMatchKey } from "../ingestion/source-identity.js";
import type { FoundPerson, FoundPersonExternal, FoundPersonWithMetadata, RecordStatus } from "../db.js";

type CountRow = { count: bigint | number | string };

export type UpsertPersonInput = {
  fullName: string;
  relevantInfo?: string | null;
  sourceUrl: string;
  sourceHash?: string;
  status?: RecordStatus;
  documentId?: string | null;
  raw?: Record<string, unknown>;
};

export async function listPeople(page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    prisma.$queryRaw<FoundPerson[]>`
      SELECT ${selectColumnsSql()} FROM found_people
      WHERE status IN ('verified', 'citizen_report')
      ORDER BY lower(full_name) ASC, source_url ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    prisma.foundPerson.count({ where: publicVisibleWhere() }),
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
  return Prisma.sql`${publicVisibleStatusSql()}
    AND (
      unaccent(lower(full_name)) ILIKE unaccent(lower(${nameQuery}))
      OR (
        ${documentQuery}::text IS NOT NULL
        AND document_id LIKE ${documentQuery}
      )
    )`;
}

type PreparedUpsertPerson = UpsertPersonInput & {
  hash: string;
  status: RecordStatus;
  documentId: string | null;
  sourceUrlMatchKey: string | null;
};

export async function upsertPeople(people: UpsertPersonInput[]) {
  const preparedPeople = await Promise.all(people.map(prepareUpsertPerson));
  const matchCache = await prefetchExistingIngestMatches(preparedPeople);
  const updates: ExistingIngestPerson[] = [];
  const inserts: ExistingIngestPerson[] = [];

  for (const person of preparedPeople) {
    const existing = matchCache.find(person);

    if (existing) {
      const enriched = enrichExistingPerson(existing, person, { hash: person.hash, status: person.status, documentId: person.documentId });
      const planned = plannedExistingRow(existing, enriched);
      const pendingInsertIndex = inserts.findIndex((row) => row.id === planned.id);
      if (pendingInsertIndex >= 0) {
        inserts[pendingInsertIndex] = planned;
      } else {
        updates.push(planned);
      }
      matchCache.remember(planned);
      continue;
    }

    const planned = plannedInsertRow(person);
    inserts.push(planned);
    matchCache.remember(planned);
  }

  const [updatedRows, insertedRows] = await Promise.all([
    bulkUpdateFoundPeople(updates),
    bulkInsertFoundPeople(inserts),
  ]);

  return [...updatedRows, ...insertedRows];
}

async function prepareUpsertPerson(person: UpsertPersonInput): Promise<PreparedUpsertPerson> {
  return {
    ...person,
    hash: person.sourceHash ?? await sha256(`${person.sourceUrl}:${person.fullName}`),
    status: person.status ?? "verified",
    documentId: normalizeDocumentId(person.documentId),
    sourceUrlMatchKey: personSpecificSourceUrlMatchKey(person.sourceUrl),
  };
}

function plannedExistingRow(existing: ExistingIngestPerson, enriched: EnrichedPerson): ExistingIngestPerson {
  return {
    id: existing.id,
    fullName: enriched.fullName,
    relevantInfo: enriched.relevantInfo,
    documentId: enriched.documentId,
    sourceUrl: enriched.sourceUrl,
    sourceHash: existing.sourceHash,
    status: enriched.status,
    raw: enriched.raw as Prisma.JsonObject,
  };
}

function plannedInsertRow(person: PreparedUpsertPerson): ExistingIngestPerson {
  return {
    id: crypto.randomUUID(),
    fullName: person.fullName,
    relevantInfo: person.relevantInfo ?? null,
    documentId: person.documentId,
    sourceUrl: person.sourceUrl,
    sourceHash: person.hash,
    status: person.status,
    raw: (person.raw ?? {}) as Prisma.JsonObject,
  };
}

async function bulkUpdateFoundPeople(rows: ExistingIngestPerson[]) {
  if (rows.length === 0) return [];

  return prisma.$queryRaw<ExistingIngestPerson[]>`
    WITH data AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS data(
        id uuid,
        "fullName" text,
        "relevantInfo" text,
        "documentId" text,
        "sourceUrl" text,
        status text,
        raw jsonb
      )
    )
    UPDATE found_people SET
      full_name = data."fullName",
      relevant_info = data."relevantInfo",
      document_id = data."documentId",
      source_url = data."sourceUrl",
      status = data.status,
      raw = data.raw,
      updated_at = now()
    FROM data
    WHERE found_people.id = data.id
    RETURNING ${selectIngestMatchColumnsSql()}`;
}

async function bulkInsertFoundPeople(rows: ExistingIngestPerson[]) {
  if (rows.length === 0) return [];

  return prisma.$queryRaw<ExistingIngestPerson[]>`
    WITH data AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS data(
        id uuid,
        "fullName" text,
        "relevantInfo" text,
        "documentId" text,
        "sourceUrl" text,
        "sourceHash" text,
        status text,
        raw jsonb
      )
    )
    INSERT INTO found_people (id, full_name, relevant_info, document_id, source_url, source_hash, status, raw)
    SELECT id, "fullName", "relevantInfo", "documentId", "sourceUrl", "sourceHash", status, raw
    FROM data
    ON CONFLICT (source_hash) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      relevant_info = EXCLUDED.relevant_info,
      document_id = COALESCE(EXCLUDED.document_id, found_people.document_id),
      source_url = EXCLUDED.source_url,
      status = CASE WHEN found_people.status = 'removed' THEN found_people.status ELSE EXCLUDED.status END,
      raw = EXCLUDED.raw,
      updated_at = now()
    RETURNING ${selectIngestMatchColumnsSql()}`;
}

export type ExistingIngestPerson = FoundPerson & {
  documentId: string | null;
  sourceHash: string;
  raw: Prisma.JsonValue;
};

type IngestMatchInput = {
  hash: string;
  status: RecordStatus;
  documentId: string | null;
};

type EnrichedPerson = {
  fullName: string;
  relevantInfo: string | null;
  documentId: string | null;
  sourceUrl: string;
  status: RecordStatus;
  raw: Record<string, unknown>;
};

type IngestMatchLookup = {
  hash: string;
  documentId: string | null;
  sourceUrl: string;
  sourceUrlMatchKey?: string | null;
};

export class IngestMatchCache {
  private readonly bySourceHash = new Map<string, ExistingIngestPerson>();
  private readonly byDocumentId = new Map<string, ExistingIngestPerson>();
  private readonly bySourceUrl = new Map<string, ExistingIngestPerson>();

  constructor(rows: ExistingIngestPerson[] = []) {
    for (const row of rows) {
      this.remember(row, { overwrite: false });
    }
  }

  find(person: IngestMatchLookup) {
    const sourceUrlMatchKey = person.sourceUrlMatchKey ?? personSpecificSourceUrlMatchKey(person.sourceUrl);
    return this.bySourceHash.get(person.hash)
      ?? (person.documentId ? this.byDocumentId.get(person.documentId) : undefined)
      ?? (sourceUrlMatchKey ? this.bySourceUrl.get(sourceUrlMatchKey) : undefined)
      ?? null;
  }

  remember(row: ExistingIngestPerson, options: { overwrite?: boolean } = {}) {
    const overwrite = options.overwrite ?? true;
    setIfAllowed(this.bySourceHash, row.sourceHash, row, overwrite);
    if (row.documentId) setIfAllowed(this.byDocumentId, row.documentId, row, overwrite);
    const sourceUrlMatchKey = personSpecificSourceUrlMatchKey(row.sourceUrl);
    if (sourceUrlMatchKey) setIfAllowed(this.bySourceUrl, sourceUrlMatchKey, row, overwrite);
  }
}

function setIfAllowed(map: Map<string, ExistingIngestPerson>, key: string, row: ExistingIngestPerson, overwrite: boolean) {
  if (overwrite || !map.has(key)) map.set(key, row);
}

async function prefetchExistingIngestMatches(people: PreparedUpsertPerson[]) {
  if (people.length === 0) return new IngestMatchCache();

  const sourceHashes = uniqueValues(people.map((person) => person.hash));
  const documentIds = uniqueValues(people.map((person) => person.documentId).filter((value): value is string => Boolean(value)));
  const sourceUrls = uniqueValues(people.map((person) => person.sourceUrlMatchKey).filter((value): value is string => Boolean(value)));
  const filters: Prisma.Sql[] = [Prisma.sql`source_hash IN (${Prisma.join(sourceHashes)})`];
  if (documentIds.length > 0) filters.push(Prisma.sql`document_id IN (${Prisma.join(documentIds)})`);
  if (sourceUrls.length > 0) filters.push(Prisma.sql`source_url IN (${Prisma.join(sourceUrls)})`);

  const rows = await prisma.$queryRaw<ExistingIngestPerson[]>`
    SELECT ${selectIngestMatchColumnsSql()}
    FROM found_people
    WHERE ${orSql(filters)}
    ORDER BY updated_at DESC`;

  return new IngestMatchCache(rows);
}

function uniqueValues(values: string[]) {
  return [...new Set(values)];
}

function orSql(filters: Prisma.Sql[]) {
  return filters.slice(1).reduce((where, filter) => Prisma.sql`${where} OR ${filter}`, filters[0]!);
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
    status: mergeStatus(existing.status, match.status),
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

function mergeStatus(existing: RecordStatus, incoming: RecordStatus): RecordStatus {
  if (existing === "removed") return "removed";
  if (existing === "verified") return "verified";
  if (incoming === "verified") return "verified";
  if (existing === "citizen_report") return "citizen_report";
  return incoming;
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

export async function updatePersonStatus(id: string, status: RecordStatus) {
  return prisma.$queryRaw<FoundPerson[]>`
    UPDATE found_people SET status = ${status}, updated_at = now()
    WHERE id = ${id}::uuid
    RETURNING ${selectColumnsSql()}`;
}

export async function getFoundPeopleStats() {
  const [result] = await prisma.$queryRaw<Array<{ total: bigint; visible: bigint; citizen_reports: bigint; needs_review: bigint; verified: bigint; removed: bigint }>>`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE status IN ('verified', 'citizen_report')) AS visible,
      count(*) FILTER (WHERE status = 'citizen_report') AS citizen_reports,
      count(*) FILTER (WHERE status = 'needs_review') AS needs_review,
      count(*) FILTER (WHERE status = 'verified') AS verified,
      count(*) FILTER (WHERE status = 'removed') AS removed
    FROM found_people`;
  const metrics = await getBotMetrics();
  return {
    total: Number(result?.total ?? 0),
    visible: Number(result?.visible ?? 0),
    citizenReports: Number(result?.citizen_reports ?? 0),
    needsReview: Number(result?.needs_review ?? 0),
    verified: Number(result?.verified ?? 0),
    removed: Number(result?.removed ?? 0),
    metrics,
  };
}

export async function listRecentCitizenReports(limit: number, status?: RecordStatus) {
  const statusFilter = status ? Prisma.sql`AND status = ${status}` : Prisma.empty;
  return prisma.$queryRaw<FoundPersonWithMetadata[]>`
    SELECT ${selectColumnsSql()},
           created_at AS "createdAt",
           updated_at AS "updatedAt",
           raw->>'provider' AS provider
    FROM found_people
    WHERE raw->>'provider' = 'telegram_report'
      AND status <> 'removed'
      ${statusFilter}
    ORDER BY updated_at DESC
    LIMIT ${limit}`;
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
      WHERE status IN ('verified', 'citizen_report')
      ORDER BY lower(full_name) ASC, source_url ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    prisma.foundPerson.count({ where: publicVisibleWhere() }),
  ]);
  return pageResult(items, page, pageSize, total);
}

export async function searchPeopleExternal(search: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const nameQuery = `%${search}%`;
  const documentDigits = normalizeDocumentDigits(search);
  const documentQuery = documentDigits ? `%${documentDigits}%` : null;
  const where = Prisma.sql`${publicVisibleStatusSql()}
    AND (
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
  const where = Prisma.sql`${publicVisibleStatusSql()}
    AND unaccent(lower(full_name)) ILIKE unaccent(lower(${nameQuery}))`;
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
  const where = Prisma.sql`${publicVisibleStatusSql()} AND document_id LIKE ${documentQuery}`;
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

function publicVisibleWhere() {
  return { status: { in: ["verified", "citizen_report"] } };
}

function publicVisibleStatusSql() {
  return Prisma.sql`status IN ('verified', 'citizen_report')`;
}

function selectColumnsSql() {
  return Prisma.sql`id,
    full_name AS "fullName",
    relevant_info AS "relevantInfo",
    source_url AS "sourceUrl",
    status AS "status"`;
}

function selectIngestMatchColumnsSql() {
  return Prisma.sql`found_people.id,
    found_people.full_name AS "fullName",
    found_people.relevant_info AS "relevantInfo",
    found_people.source_url AS "sourceUrl",
    found_people.status AS "status",
    found_people.document_id AS "documentId",
    found_people.source_hash AS "sourceHash",
    found_people.raw AS "raw"`;
}

function selectColumnsExternalSql() {
  return Prisma.sql`id,
    full_name AS "fullName",
    relevant_info AS "relevantInfo",
    source_url AS "sourceUrl",
    status AS "status",
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
