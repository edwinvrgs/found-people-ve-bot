import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runFoundPeopleIngest } from "./run-ingestion.js";
import type { SearchProviderResult } from "./search-provider.js";

function tmpOutputDir() {
  return mkdtempSync(path.join(tmpdir(), "found-people-ingest-test-"));
}

function captureLogger() {
  const entries: Array<{ details: Record<string, unknown>; message?: string }> = [];
  return {
    entries,
    logger: {
      info: (details: Record<string, unknown>, message?: string) => entries.push({ details, message }),
    },
  };
}

function sampleResult(): SearchProviderResult {
  return {
    candidates: [
      {
        fullName: "  María   Pérez  ",
        relevantInfo: "Hospital Central",
        sourceUrl: "https://example.com/a",
        documentId: "V-12.345.678",
        sourceHash: "hash-a",
        raw: { provider: "test_provider" },
      },
      {
        fullName: "A",
        relevantInfo: "too short",
        sourceUrl: "https://example.com/b",
        sourceHash: "hash-b",
        raw: { provider: "test_provider" },
      },
    ],
    errors: ["test_provider page 1: 500"],
    rejected: [{ provider: "socialcrawl", query: "q", reason: "no_url", url: null, title: null, text: null }],
  };
}

describe("runFoundPeopleIngest", () => {
  it("normalizes candidates, writes a report, and logs stages in dry-run mode", async () => {
    const outputDir = tmpOutputDir();
    const { entries, logger } = captureLogger();

    try {
      const { outputPath, report } = await runFoundPeopleIngest({
        queryLimit: 0,
        write: false,
        outputDir,
        logger,
        searchCandidates: async () => sampleResult(),
      });

      assert.equal(report.counts.candidates, 2);
      assert.equal(report.counts.accepted, 1);
      assert.equal(report.counts.skipped, 1);
      assert.equal(report.counts.providerErrors, 1);
      assert.equal(report.counts.rejectedByProvider, 1);
      assert.equal(report.counts.upserted, 0);
      assert.equal(report.accepted[0]?.fullName, "María Pérez");
      assert.equal(report.accepted[0]?.documentId, "12345678");

      const persisted = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.equal(persisted.counts.accepted, 1);
      assert.deepEqual(entries.map((entry) => entry.details.event).filter(Boolean), [
        "ingest_started",
        "ingest_candidate_search_started",
        "ingest_candidate_search_completed",
        "ingest_candidates_normalized",
        "ingest_report_written",
        "ingest_completed",
      ]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("ensures schema and writes accepted candidates in batches", async () => {
    const outputDir = tmpOutputDir();
    const { entries, logger } = captureLogger();
    const batches: unknown[][] = [];
    let ensured = false;

    try {
      const result: SearchProviderResult = {
        candidates: [
          { fullName: "Persona Uno", relevantInfo: "info", sourceUrl: "https://example.com/1", sourceHash: "1" },
          { fullName: "Persona Dos", relevantInfo: "info", sourceUrl: "https://example.com/2", sourceHash: "2" },
          { fullName: "Persona Tres", relevantInfo: "info", sourceUrl: "https://example.com/3", sourceHash: "3" },
        ],
        errors: [],
      };

      const { report } = await runFoundPeopleIngest({
        queryLimit: 0,
        write: true,
        outputDir,
        batchSize: 2,
        logger,
        searchCandidates: async () => result,
        ensureSchema: async () => { ensured = true; },
        upsertPeople: async (people) => {
          batches.push(people);
          return people.map((person) => ({ person }));
        },
      });

      assert.equal(ensured, true);
      assert.equal(report.counts.upserted, 3);
      assert.deepEqual(batches.map((batch) => batch.length), [2, 1]);
      assert.equal(entries.filter((entry) => entry.details.event === "ingest_db_batch_started").length, 2);
      assert.equal(entries.filter((entry) => entry.details.event === "ingest_db_batch_completed").length, 2);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("logs progress while candidate search is still running", async () => {
    const outputDir = tmpOutputDir();
    const { entries, logger } = captureLogger();

    try {
      await runFoundPeopleIngest({
        queryLimit: 0,
        write: false,
        outputDir,
        progressIntervalMs: 5,
        logger,
        searchCandidates: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { candidates: [], errors: [] };
        },
      });

      assert.equal(entries.some((entry) => entry.details.event === "ingest_candidate_search_waiting"), true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
