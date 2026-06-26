import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { buildExternalReportUpsertInput } from "./found-people-service.js";

describe("external found-person reports", () => {
  it("builds a stable external report upsert input from an idempotency key", () => {
    const input = buildExternalReportUpsertInput(
      {
        fullName: "María Pérez",
        location: "Hospital Central",
        notes: "Fue localizada por brigadistas",
        reporter: { service: "partner-api" },
      },
      { idempotencyKey: " report-123 ", publicBaseUrl: "https://bot.example.com" },
    );

    const normalizedKey = "report-123";
    const reportHash = createHash("sha256").update(normalizedKey).digest("hex");

    assert.equal(input.fullName, "María Pérez");
    assert.equal(input.sourceHash, `external-report:${reportHash}`);
    assert.equal(input.sourceUrl, `https://bot.example.com/api/v1/found-people/reports/${reportHash.slice(0, 16)}`);
    assert.match(input.relevantInfo ?? "", /Hospital Central/);
    assert.match(input.relevantInfo ?? "", /Fue localizada/);
    assert.deepEqual(input.raw?.reporter, { service: "partner-api" });
    assert.equal(input.raw?.idempotencyKeyHash, reportHash);
    assert.equal("status" in input, false);
  });

  it("keeps a submitted source URL and omits idempotency hash when no key is provided", () => {
    const input = buildExternalReportUpsertInput(
      {
        fullName: "Carlos Ramos",
        location: "Refugio municipal",
        sourceUrl: "https://example.org/report/carlos",
      },
      { publicBaseUrl: "https://bot.example.com" },
    );

    assert.equal(input.sourceUrl, "https://example.org/report/carlos");
    assert.equal(input.raw?.submittedSourceUrl, "https://example.org/report/carlos");
    assert.equal(input.raw?.idempotencyKeyHash, null);
    assert.match(input.relevantInfo ?? "", /fuente enviada por servicio externo/);
  });
});
