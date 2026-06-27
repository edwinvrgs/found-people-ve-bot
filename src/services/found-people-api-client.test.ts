import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { listFoundPeopleFromApi, toPublicFoundPersonPage } from "./found-people-api-client.js";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.FOUND_PEOPLE_API_BASE_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.FOUND_PEOPLE_API_BASE_URL;
  else process.env.FOUND_PEOPLE_API_BASE_URL = originalBaseUrl;
});

test("requests the external unified list endpoint with paginated document filters", async () => {
  process.env.FOUND_PEOPLE_API_BASE_URL = "https://api.example.test";
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({
      data: [{
        id: "00000000-0000-0000-0000-000000000001",
        full_name: "Norelys Piñerua",
        document_id: "12345678",
        relevant_info: "Hospital A",
        source_url: "https://example.test/source",
      }],
      pagination: { page: 2, page_size: 5, total: 8, total_pages: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const result = await listFoundPeopleFromApi({ page: 2, pageSize: 5, documentId: "12345678" });

  const url = new URL(requestedUrls[0]!);
  assert.equal(url.href, "https://api.example.test/api/v1/found-people?page=2&page_size=5&document_id=12345678");
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 5);
  assert.equal(result.total, 8);
  assert.equal(result.totalPages, 2);
  assert.deepEqual(result.items[0], {
    id: "00000000-0000-0000-0000-000000000001",
    fullName: "Norelys Piñerua",
    documentId: "12345678",
    relevantInfo: "Hospital A",
    sourceUrl: "https://example.test/source",
  });
});

test("requests name searches through the same external list endpoint", async () => {
  process.env.FOUND_PEOPLE_API_BASE_URL = "https://api.example.test/base/";
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      data: [],
      pagination: { page: 1, page_size: 5, total: 0, total_pages: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await listFoundPeopleFromApi({ page: 1, pageSize: 5, name: "Piñerua" });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/api/v1/found-people");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("page_size"), "5");
  assert.equal(url.searchParams.get("name"), "Piñerua");
});

test("can hide API document ids for the public bot shape", async () => {
  const page = toPublicFoundPersonPage({
    items: [{ id: "1", fullName: "Persona", documentId: "12345678", relevantInfo: null, sourceUrl: "https://example.test" }],
    page: 1,
    pageSize: 5,
    total: 1,
    totalPages: 1,
  });

  assert.deepEqual(page.items, [{ id: "1", fullName: "Persona", relevantInfo: null, sourceUrl: "https://example.test" }]);
});
