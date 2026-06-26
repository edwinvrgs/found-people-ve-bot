import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rateLimit, sweepRateLimitBuckets } from "./rate-limit.js";

describe("rate limiter smoke tests", () => {
  it("allows requests up to the configured limit and then blocks", () => {
    const key = `test:${Date.now()}:${Math.random()}`;

    assert.deepEqual(rateLimit(key, 2, 60_000), { allowed: true, retryAfterSeconds: 0 });
    assert.deepEqual(rateLimit(key, 2, 60_000), { allowed: true, retryAfterSeconds: 0 });

    const limited = rateLimit(key, 2, 60_000);
    assert.equal(limited.allowed, false);
    assert.ok(limited.retryAfterSeconds > 0);
  });

  it("resets buckets after their window expires", async () => {
    const key = `test-reset:${Date.now()}:${Math.random()}`;
    assert.equal(rateLimit(key, 1, 5).allowed, true);
    assert.equal(rateLimit(key, 1, 5).allowed, false);

    await new Promise((resolve) => setTimeout(resolve, 10));
    sweepRateLimitBuckets();

    assert.equal(rateLimit(key, 1, 5).allowed, true);
  });
});
