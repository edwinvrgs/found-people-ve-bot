import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enrichExistingPerson, IngestMatchCache, type ExistingIngestPerson, type UpsertPersonInput } from "./found-people-repository.js";

const baseExisting = {
  id: "00000000-0000-0000-0000-000000000001",
  fullName: "Maria Perez",
  relevantInfo: "Hospital A",
  sourceUrl: "https://example.com/original",
  sourceHash: "hash-original",
  status: "verified" as const,
  documentId: null,
  raw: { provider: "original" },
};

const baseIncoming: UpsertPersonInput = {
  fullName: "María Alejandra Pérez",
  relevantInfo: "Hospital A, piso 2, estable",
  sourceUrl: "https://example.com/new-source",
  sourceHash: "hash-new",
  status: "verified",
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
      status: "verified",
      documentId: "12345678",
    });

    assert.equal(enriched.documentId, "12345678");
    assert.equal(enriched.sourceUrl, "https://example.com/new-source");
    assert.equal((enriched.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.matchedBy, "source_hash");
  });

  it("keeps the more informative name/info on document matches without replacing the primary source URL", () => {
    const enriched = enrichExistingPerson({ ...baseExisting, documentId: "12345678" }, baseIncoming, {
      hash: "hash-new",
      status: "verified",
      documentId: "12345678",
    });

    assert.equal(enriched.fullName, "María Alejandra Pérez");
    assert.equal(enriched.documentId, "12345678");
    assert.equal(enriched.relevantInfo, "Hospital A, piso 2, estable");
    assert.equal(enriched.sourceUrl, "https://example.com/original");
    assert.equal((enriched.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.matchedBy, "document_id");
  });

  it("does not revive removed records", () => {
    const enriched = enrichExistingPerson({ ...baseExisting, status: "removed" }, baseIncoming, {
      hash: "hash-original",
      status: "verified",
      documentId: "12345678",
    });

    assert.equal(enriched.status, "removed");
  });

  it("does not downgrade verified records", () => {
    const enriched = enrichExistingPerson(baseExisting, { ...baseIncoming, status: "needs_review" }, {
      hash: "hash-original",
      status: "needs_review",
      documentId: "12345678",
    });

    assert.equal(enriched.status, "verified");
  });

  it("tracks repeated ingestion sources in raw metadata", () => {
    const enriched = enrichExistingPerson({ ...baseExisting, documentId: "12345678" }, baseIncoming, {
      hash: "hash-new",
      status: "verified",
      documentId: "12345678",
    });

    assert.deepEqual(enriched.raw.latestIngestion, { provider: "new" });
    assert.equal(Array.isArray(enriched.raw.ingestionSources), true);
    assert.equal((enriched.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.sourceHash, "hash-new");
    assert.equal((enriched.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.matchedBy, "document_id");
  });

  it("keeps person-specific URL matches idempotent", () => {
    const personUrl = "https://venezuelatebusca.com/?status=found&page=100#record=abc";
    const sameUrl = enrichExistingPerson({ ...baseExisting, sourceUrl: personUrl }, { ...baseIncoming, sourceUrl: personUrl }, {
      hash: "hash-new",
      status: "verified",
      documentId: null,
    });

    assert.equal(sameUrl.sourceUrl, personUrl);
    assert.equal((sameUrl.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.matchedBy, "source_url");
  });

  it("prefers source hash over document and URL matches in the batch cache", () => {
    const hashMatch = ingestPerson({ id: "00000000-0000-0000-0000-000000000011", sourceHash: "hash-incoming", documentId: "11111111", sourceUrl: "https://example.com/hash" });
    const documentMatch = ingestPerson({ id: "00000000-0000-0000-0000-000000000012", sourceHash: "hash-doc", documentId: "12345678", sourceUrl: "https://example.com/doc" });
    const urlMatch = ingestPerson({ id: "00000000-0000-0000-0000-000000000013", sourceHash: "hash-url", documentId: null, sourceUrl: "https://venezuelatebusca.com/?status=found&page=100#record=abc" });
    const cache = new IngestMatchCache([urlMatch, documentMatch, hashMatch]);

    assert.equal(cache.find({ hash: "hash-incoming", documentId: "12345678", sourceUrl: "https://venezuelatebusca.com/?status=found&page=100#record=abc" })?.id, hashMatch.id);
  });

  it("does not match shared list page URLs in the ingest cache", () => {
    const listPageOne = ingestPerson({ id: "00000000-0000-0000-0000-000000000031", sourceHash: "hash-list-1", fullName: "Claribel García", sourceUrl: "https://venezuelatebusca.com/?status=found&page=100" });
    const listPageTwo = ingestPerson({ id: "00000000-0000-0000-0000-000000000032", sourceHash: "hash-list-2", fullName: "Alberto Fuentes", sourceUrl: "https://venezuelatebusca.com/?status=found&page=100" });
    const cache = new IngestMatchCache([listPageOne]);

    assert.equal(cache.find({ hash: listPageTwo.sourceHash, documentId: null, sourceUrl: listPageTwo.sourceUrl }), null);
  });

  it("does match person-specific source URLs in the ingest cache", () => {
    const personUrl = "https://venezuelatebusca.com/?status=found&page=100#record=abc";
    const cached = ingestPerson({ id: "00000000-0000-0000-0000-000000000041", sourceHash: "hash-person-1", sourceUrl: personUrl });
    const cache = new IngestMatchCache([cached]);

    assert.equal(cache.find({ hash: "hash-person-2", documentId: null, sourceUrl: personUrl })?.id, cached.id);
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
