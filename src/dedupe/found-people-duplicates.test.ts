import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDuplicateAuditReport, nameSimilarity, normalizeName, type DuplicateAuditRow } from "./found-people-duplicates.js";

const row = (overrides: Partial<DuplicateAuditRow>): DuplicateAuditRow => ({
  id: crypto.randomUUID(),
  fullName: "Persona Test",
  documentId: null,
  sourceUrl: `https://example.com/${crypto.randomUUID()}`,
  status: "verified",
  raw: { source: "test_source" },
  ...overrides,
});

describe("found-person duplicate audit", () => {
  it("normalizes names for accent/case-insensitive matching", () => {
    assert.equal(normalizeName("  María   FÉLIX Águilar, C.I. 123 "), "maria felix aguilar");
  });

  it("finds high-confidence duplicate clusters by document ID", () => {
    const report = buildDuplicateAuditReport([
      row({ fullName: "Ana Díaz", documentId: "10576803", raw: { source: "github_ocr" } }),
      row({ fullName: "Ana Felicia Dias", documentId: "10576803", raw: { source: "desaparecidos_terremoto" } }),
      row({ fullName: "Otra Persona", documentId: "20000000" }),
    ]);

    assert.equal(report.summary.sameDocumentClusters, 1);
    assert.equal(report.clusters.sameDocumentId[0]?.confidence, "high");
    assert.deepEqual(report.clusters.sameDocumentId[0]?.sources.sort(), ["desaparecidos_terremoto", "github_ocr"]);
  });

  it("finds normalized-name clusters separately from document clusters", () => {
    const report = buildDuplicateAuditReport([
      row({ fullName: "José Gregorio Castellanos Rivera", raw: { source: "encuentralos" } }),
      row({ fullName: "Jose Gregorio Castellanos Rivera", raw: { source: "venezuelatebusca" } }),
    ]);

    assert.equal(report.summary.sameNormalizedNameClusters, 1);
    assert.equal(report.clusters.sameNormalizedName[0]?.key, "jose gregorio castellanos rivera");
  });

  it("finds high-similarity name pairs without crossing conflicting document IDs", () => {
    const report = buildDuplicateAuditReport([
      row({ fullName: "José Gregorio Castellano Rivera", documentId: null }),
      row({ fullName: "José Gregorio Castellanos Rivera", documentId: null }),
      row({ fullName: "José Gregorio Castellano Rivera", documentId: "11111111" }),
      row({ fullName: "José Gregorio Castellanos Rivera", documentId: "22222222" }),
    ]);

    assert.ok(nameSimilarity("José Gregorio Castellano Rivera", "Jose Gregorio Castellanos Rivera") > 0.94);
    assert.ok(report.summary.highSimilarityPairs >= 1);
    assert.equal(
      report.clusters.similarNamePairs.some((pair) => pair.people.every((person) => person.documentId) && pair.people[0].documentId !== pair.people[1].documentId),
      false,
    );
  });
});
