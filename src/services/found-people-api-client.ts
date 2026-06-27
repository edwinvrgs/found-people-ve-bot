import { z } from "zod";
import type { FoundPerson, FoundPersonExternal } from "../db.js";
import { env } from "../config/env.js";

export type FoundPeoplePage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type FoundPeopleApiSearch = {
  page: number;
  pageSize: number;
  q?: string;
  name?: string;
  documentId?: string;
};

const ApiPersonSchema = z.object({
  id: z.string(),
  full_name: z.string(),
  document_id: z.string().nullable().optional(),
  relevant_info: z.string().nullable().optional(),
  source_url: z.string().nullable().optional(),
});

const ApiPaginationSchema = z.object({
  page: z.number(),
  page_size: z.number().optional(),
  pageSize: z.number().optional(),
  total: z.number(),
  total_pages: z.number().optional(),
  totalPages: z.number().optional(),
});

const ApiListResponseSchema = z.object({
  data: z.array(ApiPersonSchema),
  pagination: ApiPaginationSchema,
});

export function externalFoundPeopleApiConfigured() {
  return Boolean(foundPeopleApiBaseUrl());
}

export async function listFoundPeopleFromApi(input: FoundPeopleApiSearch): Promise<FoundPeoplePage<FoundPersonExternal>> {
  const baseUrl = foundPeopleApiBaseUrl();
  if (!baseUrl) throw new Error("FOUND_PEOPLE_API_BASE_URL is not configured");

  const url = new URL("/api/v1/found-people", baseUrl);
  url.searchParams.set("page", String(input.page));
  url.searchParams.set("page_size", String(input.pageSize));
  if (input.documentId) url.searchParams.set("document_id", input.documentId);
  else if (input.name) url.searchParams.set("name", input.name);
  else if (input.q) url.searchParams.set("q", input.q);

  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Found people API request failed: ${response.status}`);

  const parsed = ApiListResponseSchema.parse(await response.json());
  const pageSize = parsed.pagination.page_size ?? parsed.pagination.pageSize ?? input.pageSize;
  const totalPages = parsed.pagination.total_pages ?? parsed.pagination.totalPages ?? (parsed.pagination.total > 0 ? Math.ceil(parsed.pagination.total / pageSize) : 0);

  return {
    items: parsed.data.map(apiPersonToFoundPerson),
    page: parsed.pagination.page,
    pageSize,
    total: parsed.pagination.total,
    totalPages,
  };
}

function foundPeopleApiBaseUrl() {
  return (env.foundPeopleApiBaseUrl ?? process.env.FOUND_PEOPLE_API_BASE_URL)?.replace(/\/$/, "");
}

function apiPersonToFoundPerson(person: z.infer<typeof ApiPersonSchema>): FoundPersonExternal {
  return {
    id: person.id,
    fullName: person.full_name,
    documentId: person.document_id ?? null,
    relevantInfo: person.relevant_info ?? null,
    sourceUrl: person.source_url ?? "https://venezuela-war-room.github.io/",
  };
}

export function toPublicFoundPersonPage(page: FoundPeoplePage<FoundPersonExternal>): FoundPeoplePage<FoundPerson> {
  return {
    ...page,
    items: page.items.map(({ documentId: _documentId, ...person }) => person),
  };
}
