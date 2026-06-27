import { z } from "zod";

const SEARCH_QUERY_MAX_LENGTH = 80;
const SEARCH_QUERY_SAFE_CHARS = /^[\p{L}\p{M}\d .,'’_-]+$/u;

function normalizeSearchQuery(value: unknown) {
  if (typeof value !== "string") return value;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

const SafeSearchQuerySchema = z.preprocess(
  normalizeSearchQuery,
  z.string()
    .min(2)
    .max(SEARCH_QUERY_MAX_LENGTH)
    .regex(SEARCH_QUERY_SAFE_CHARS, "Search contains unsupported characters")
    .optional(),
);

function coercePageSize(value: Record<string, unknown>) {
  return { ...value, pageSize: value.pageSize ?? value.page_size };
}

function coerceDocumentId(value: Record<string, unknown>) {
  return { ...value, documentId: value.documentId ?? value.document_id };
}

const PeopleQuerySchema = z.preprocess(
  (value) => value && typeof value === "object" && !Array.isArray(value) ? coercePageSize(value as Record<string, unknown>) : value,
  z.object({
    page: z.coerce.number().int().min(1).max(500).default(1),
    pageSize: z.coerce.number().int().min(1).max(10).default(5),
    q: SafeSearchQuerySchema,
  }),
);

const TelegramSearchQuerySchema = z.string().trim().min(2).max(80);

const ExternalListQuerySchema = z.preprocess(
  (value) => value && typeof value === "object" && !Array.isArray(value)
    ? coerceDocumentId(coercePageSize(value as Record<string, unknown>))
    : value,
  z.object({
    page: z.coerce.number().int().min(1).max(500).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    name: SafeSearchQuerySchema,
    q: SafeSearchQuerySchema,
    documentId: z.preprocess(
      (v) => typeof v === "string" ? v.replace(/\D/g, "") : v,
      z.string().min(6).max(9).optional(),
    ),
  }),
);

const PersonPayloadSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  relevantInfo: z.string().trim().max(5000).nullable().optional(),
  sourceUrl: z.string().url().refine((url) => /^https?:\/\//i.test(url), "Only http(s) URLs are allowed"),
  sourceHash: z.string().trim().min(16).max(128).optional(),
  documentId: z.string().trim().regex(/^\d{6,9}$/).nullable().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

const IngestSchema = z.object({
  people: z.array(PersonPayloadSchema).min(1).max(200),
});

const DeletePersonSchema = z.object({
  sourceUrl: z.string().url().refine((url) => /^https?:\/\//i.test(url), "Only http(s) URLs are allowed"),
});

const ExternalReportSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  location: z.string().trim().min(2).max(300),
  sourceUrl: z.string().trim().url().refine((url) => /^https?:\/\//i.test(url), "Only http(s) URLs are allowed").optional(),
  notes: z.string().trim().max(1000).optional(),
  reporter: z.object({
    name: z.string().trim().max(120).optional(),
    contact: z.string().trim().max(200).optional(),
    service: z.string().trim().max(80).optional(),
  }).strict().optional(),
}).strict();

export { DeletePersonSchema, ExternalListQuerySchema, ExternalReportSchema, IngestSchema, PeopleQuerySchema, TelegramSearchQuerySchema };

export function lengthBucket(length: number) {
  if (length <= 0) return "empty";
  if (length <= 10) return "1-10";
  if (length <= 30) return "11-30";
  if (length <= 80) return "31-80";
  if (length <= 200) return "81-200";
  return "201+";
}
