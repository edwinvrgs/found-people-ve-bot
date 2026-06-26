import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { scrapeApiSource, shouldStopApiPagination } from "./tiltely-source.js";

const originalFetch = globalThis.fetch;
const originalPageLimit = process.env.TILTELY_DESAPARECIDOS_API_PAGES;
const originalPageDelay = process.env.TILTELY_API_PAGE_DELAY_MS;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPageLimit === undefined) delete process.env.TILTELY_DESAPARECIDOS_API_PAGES;
  else process.env.TILTELY_DESAPARECIDOS_API_PAGES = originalPageLimit;
  if (originalPageDelay === undefined) delete process.env.TILTELY_API_PAGE_DELAY_MS;
  else process.env.TILTELY_API_PAGE_DELAY_MS = originalPageDelay;
});

describe("Tiltely API pagination", () => {
  it("stops pagination on auth/rate-limit statuses", () => {
    assert.equal(shouldStopApiPagination(401), true);
    assert.equal(shouldStopApiPagination(403), true);
    assert.equal(shouldStopApiPagination(429), true);
    assert.equal(shouldStopApiPagination(500), false);
  });

  it("does not burn every page when an API source requires reCAPTCHA", async () => {
    process.env.TILTELY_DESAPARECIDOS_API_PAGES = "250";
    process.env.TILTELY_API_PAGE_DELAY_MS = "0";
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ error: "ForbiddenError", message: "Verificación reCAPTCHA requerida" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await scrapeApiSource(
      "desaparecidos_terremoto",
      "https://desaparecidos-terremoto-api.theempire.tech/api/personas",
      "https://desaparecidosterremotovenezuela.com/",
      true,
    );

    assert.equal(requestedUrls.length, 1);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.errors, ["desaparecidos_terremoto page 1: 403"]);
  });
});
