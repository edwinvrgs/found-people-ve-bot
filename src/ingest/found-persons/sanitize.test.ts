import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractDocumentId, maskDocumentNumbers, normalizeDocumentId, sanitizeRelevantInfo } from "./sanitize.js";

describe("found-person sanitization", () => {
  it("normalizes Venezuelan document IDs from common public formats", () => {
    assert.equal(normalizeDocumentId("V-12.345.678"), "12345678");
    assert.equal(normalizeDocumentId("12 345 678"), "12345678");
    assert.equal(normalizeDocumentId("12345"), null);
    assert.equal(normalizeDocumentId("1234567890"), null);
  });

  it("extracts the first valid document ID from free text", () => {
    assert.equal(extractDocumentId("Paciente V-24.123.456 atendido en emergencia"), "24123456");
  });

  it("masks document numbers before exposing relevant info", () => {
    assert.equal(
      maskDocumentNumbers("Cédula V-24.123.456 localizada"),
      "Cédula cédula terminada en 3456 localizada",
    );
    assert.equal(
      sanitizeRelevantInfo("  Cédula V-24.123.456   localizada  "),
      "Cédula cédula terminada en 3456 localizada",
    );
  });
});
