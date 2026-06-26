import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enrichExistingPerson, IngestMatchCache, type ExistingIngestPerson, type UpsertPersonInput } from "./found-people-repository.js";

const baseExisting = {
  id: "00000000-0000-0000-0000-000000000001",
  fullName: "Maria Perez",
  relevantInfo: "Hospital A",
  sourceUrl: "https://example.com/original",
  sourceHash: "hash-original",
  documentId: null,
  raw: { provider: "original" },
};

const baseIncoming: UpsertPersonInput = {
  fullName: "María Alejandra Pérez",
  relevantInfo: "Hospital A, piso 2, estable",
  sourceUrl: "https://example.com/new-source",
  sourceHash: "hash-new",
  documentId: "12345678",
  raw: { provider: "new" },
};

const ingestPerson = (overrides: Partial<ExistingIngestPerson>): ExistingIngestPerson => ({
  ...baseExisting,
  sourceHash: "hash-original",
  raw: { provider: "original" },
  ...overrides,
});

describe("ingest enrichment", () => {
  it("fills missing document IDs on same-source matches", () => {
    const enriched = enrichExistingPerson(baseExisting, baseIncoming, {
      hash: "hash-original",
      documentId: "12345678",
    });

    assert.equal(enriched.documentId, "12345678");
    assert.equal(enriched.sourceUrl, "https://example.com/new-source");
    assert.equal((enriched.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.matchedBy, "source_hash");
  });

  it("keeps the more informative name/info on document matches without replacing the primary source URL", () => {
    const enriched = enrichExistingPerson({ ...baseExisting, documentId: "12345678" }, baseIncoming, {
      hash: "hash-new",
      documentId: "12345678",
    });

    assert.equal(enriched.fullName, "María Alejandra Pérez");
    assert.equal(enriched.documentId, "12345678");
    assert.equal(enriched.relevantInfo, "Hospital A, piso 2, estable");
    assert.equal(enriched.sourceUrl, "https://example.com/original");
    assert.equal((enriched.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.matchedBy, "document_id");
  });

  it("tracks repeated ingestion sources in raw metadata", () => {
    const enriched = enrichExistingPerson({ ...baseExisting, documentId: "12345678" }, baseIncoming, {
      hash: "hash-new",
      documentId: "12345678",
    });

    assert.deepEqual(enriched.raw.latestIngestion, { provider: "new" });
    assert.equal(Array.isArray(enriched.raw.ingestionSources), true);
    assert.equal((enriched.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.sourceHash, "hash-new");
    assert.equal((enriched.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.matchedBy, "document_id");
  });

  it("keeps URL matches idempotent", () => {
    const sameUrl = enrichExistingPerson(baseExisting, { ...baseIncoming, sourceUrl: baseExisting.sourceUrl }, {
      hash: "hash-new",
      documentId: null,
    });

    assert.equal(sameUrl.sourceUrl, baseExisting.sourceUrl);
    assert.equal((sameUrl.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.matchedBy, "source_url");
  });

  it("prefers source hash over document and URL matches in the batch cache", () => {
    const hashMatch = ingestPerson({ id: "00000000-0000-0000-0000-000000000011", sourceHash: "hash-incoming", documentId: "11111111", sourceUrl: "https://example.com/hash" });
    const documentMatch = ingestPerson({ id: "00000000-0000-0000-0000-000000000012", sourceHash: "hash-doc", documentId: "12345678", sourceUrl: "https://example.com/doc" });
    const urlMatch = ingestPerson({ id: "00000000-0000-0000-0000-000000000013", sourceHash: "hash-url", documentId: null, sourceUrl: "https://example.com/new-source" });
    const cache = new IngestMatchCache([urlMatch, documentMatch, hashMatch]);

    assert.equal(cache.find({ hash: "hash-incoming", documentId: "12345678", sourceUrl: "https://example.com/new-source" })?.id, hashMatch.id);
  });

  it("keeps latest prefetched match and then lets intra-batch writes update the cache", () => {
    const latest = ingestPerson({ id: "00000000-0000-0000-0000-000000000021", sourceHash: "hash-latest", documentId: "12345678" });
    const older = ingestPerson({ id: "00000000-0000-0000-0000-000000000022", sourceHash: "hash-older", documentId: "12345678" });
    const inserted = ingestPerson({ id: "00000000-0000-0000-0000-000000000023", sourceHash: "hash-new", documentId: "12345678" });
    const cache = new IngestMatchCache([latest, older]);

    assert.equal(cache.find({ hash: "missing", documentId: "12345678", sourceUrl: "https://example.com/missing" })?.id, latest.id);

    cache.remember(inserted);
    assert.equal(cache.find({ hash: "missing", documentId: "12345678", sourceUrl: "https://example.com/missing" })?.id, inserted.id);
  });
});
