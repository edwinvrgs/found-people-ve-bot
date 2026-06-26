import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
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

export async function upsertPeople(people: UpsertPersonInput[]) {
  const rows: FoundPerson[] = [];

  for (const person of people) {
    const hash = person.sourceHash ?? await sha256(`${person.sourceUrl}:${person.fullName}`);
    const status = person.status ?? "verified";
    const documentId = normalizeDocumentId(person.documentId);
    const [row] = await prisma.$queryRaw<FoundPerson[]>`
      INSERT INTO found_people (full_name, relevant_info, document_id, source_url, source_hash, status, raw)
      VALUES (${person.fullName}, ${person.relevantInfo ?? null}, ${documentId}, ${person.sourceUrl}, ${hash}, ${status}, ${JSON.stringify(person.raw ?? {})}::jsonb)
      ON CONFLICT (source_hash) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        relevant_info = EXCLUDED.relevant_info,
        document_id = COALESCE(EXCLUDED.document_id, found_people.document_id),
        source_url = EXCLUDED.source_url,
        status = CASE WHEN found_people.status = 'removed' THEN found_people.status ELSE EXCLUDED.status END,
        raw = EXCLUDED.raw,
        updated_at = now()
      RETURNING ${selectColumnsSql()}`;
    rows.push(row);
  }

  return rows;
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
