import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchProvider } from "./search-provider.js";

const silentLoggerEnv = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = "silent";

describe("searchProvider", () => {
  it("returns a provider error instead of hanging when the provider times out", async () => {
    const result = await searchProvider(
      "slow_provider",
      async (signal) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { candidates: [], errors: [] };
      },
      5,
    );

    assert.deepEqual(result.candidates, []);
    assert.equal(result.errors[0], "slow_provider: timed out after 5ms");
  });

  it("converts provider failures into partial errors", async () => {
    const result = await searchProvider("broken_provider", async () => {
      throw new Error("boom");
    });

    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.errors, ["broken_provider: boom"]);
  });

  it("passes an abort signal to provider implementations", async () => {
    let sawSignal = false;
    const result = await searchProvider("fast_provider", async (signal) => {
      sawSignal = signal instanceof AbortSignal;
      return {
        candidates: [{ fullName: "Persona Test", relevantInfo: "ok", sourceUrl: "https://example.com", sourceHash: "hash" }],
        errors: [],
      };
    });

    assert.equal(sawSignal, true);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.errors, []);
  });
});

if (silentLoggerEnv === undefined) delete process.env.LOG_LEVEL;
else process.env.LOG_LEVEL = silentLoggerEnv;
