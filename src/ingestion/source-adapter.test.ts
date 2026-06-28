import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeSearchProviderResults, runIngestionSources } from "./source-adapter.js";

function candidate(sourceHash: string, fullName = "Persona Localizada") {
  return {
    fullName,
    relevantInfo: "Localizada",
    sourceUrl: `https://example.com/${sourceHash}`,
    sourceHash,
  };
}

describe("ingestion source adapter", () => {
  it("runs enabled sources and skips disabled sources through a shared interface", async () => {
    const events: string[] = [];
    const result = await runIngestionSources([
      {
        name: "source_a",
        search: async () => ({ candidates: [candidate("a")], errors: [] }),
      },
      {
        name: "source_b",
        enabled: false,
        disabledReason: "not configured",
        search: async () => ({ candidates: [candidate("b")], errors: [] }),
      },
    ], async (name, search) => {
      events.push(`run:${name}`);
      return search(new AbortController().signal);
    }, (name, reason) => {
      events.push(`skip:${name}:${reason}`);
      return { candidates: [], errors: [] };
    });

    assert.deepEqual(events, ["run:source_a", "skip:source_b:not configured"]);
    assert.deepEqual(result.candidates.map((item) => item.sourceHash), ["a"]);
  });

  it("dedupes candidates by sourceHash while preserving errors and rejected records", () => {
    const result = mergeSearchProviderResults([
      {
        candidates: [candidate("same", "Primer Nombre")],
        errors: ["first error"],
        rejected: [{ provider: "socialcrawl", query: "q", reason: "no_url", url: null, title: null, text: null }],
      },
      {
        candidates: [candidate("same", "Segundo Nombre"), candidate("other")],
        errors: ["second error"],
      },
    ]);

    assert.deepEqual(result.candidates.map((item) => [item.sourceHash, item.fullName]), [["same", "Segundo Nombre"], ["other", "Persona Localizada"]]);
    assert.deepEqual(result.errors, ["first error", "second error"]);
    assert.equal(result.rejected?.length, 1);
  });
});
