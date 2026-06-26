import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enrichExistingPerson, type UpsertPersonInput } from "./found-people-repository.js";

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

  it("keeps URL matches idempotent", () => {
    const sameUrl = enrichExistingPerson(baseExisting, { ...baseIncoming, sourceUrl: baseExisting.sourceUrl }, {
      hash: "hash-new",
      status: "verified",
      documentId: null,
    });

    assert.equal(sameUrl.sourceUrl, baseExisting.sourceUrl);
    assert.equal((sameUrl.raw.ingestionSources as Array<Record<string, unknown>>)[0]?.matchedBy, "source_url");
  });
});
