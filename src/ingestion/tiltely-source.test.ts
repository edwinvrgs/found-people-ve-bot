import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { scrapeApiSource, searchKnownFoundPersonSources, shouldStopApiPagination } from "./tiltely-source.js";

const originalFetch = globalThis.fetch;
const originalVenezuelaTeBuscaPageLimit = process.env.TILTELY_VENEZUELA_TE_BUSCA_PAGES;
const originalDesaparecidosPageLimit = process.env.TILTELY_DESAPARECIDOS_API_PAGES;
const originalEncuentralosPageLimit = process.env.TILTELY_ENCUENTRALOS_API_PAGES;
const originalPageDelay = process.env.TILTELY_API_PAGE_DELAY_MS;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalVenezuelaTeBuscaPageLimit === undefined) delete process.env.TILTELY_VENEZUELA_TE_BUSCA_PAGES;
  else process.env.TILTELY_VENEZUELA_TE_BUSCA_PAGES = originalVenezuelaTeBuscaPageLimit;
  if (originalDesaparecidosPageLimit === undefined) delete process.env.TILTELY_DESAPARECIDOS_API_PAGES;
  else process.env.TILTELY_DESAPARECIDOS_API_PAGES = originalDesaparecidosPageLimit;
  if (originalEncuentralosPageLimit === undefined) delete process.env.TILTELY_ENCUENTRALOS_API_PAGES;
  else process.env.TILTELY_ENCUENTRALOS_API_PAGES = originalEncuentralosPageLimit;
  if (originalPageDelay === undefined) delete process.env.TILTELY_API_PAGE_DELAY_MS;
  else process.env.TILTELY_API_PAGE_DELAY_MS = originalPageDelay;
});

describe("Known found-person source ingestion", () => {
  it("queries known source URLs directly without loading the Tiltely index", async () => {
    process.env.TILTELY_VENEZUELA_TE_BUSCA_PAGES = "1";
    process.env.TILTELY_DESAPARECIDOS_API_PAGES = "1";
    process.env.TILTELY_ENCUENTRALOS_API_PAGES = "1";
    process.env.TILTELY_API_PAGE_DELAY_MS = "0";
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("venezuelatebusca.com")) {
        return new Response("<html><body>Registrar persona</body></html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await searchKnownFoundPersonSources();

    assert.equal(result.errors.length, 0);
    assert.equal(requestedUrls.some((url) => url.includes("venezuela.tiltely.com")), false);
    assert.equal(requestedUrls.some((url) => url.includes("venezuelatebusca.com")), true);
    assert.equal(requestedUrls.some((url) => url.includes("desaparecidos-terremoto-api.theempire.tech")), true);
    assert.equal(requestedUrls.some((url) => url.includes("encuentralos.tecnosoft.dev")), true);
  });
});

describe("Known found-person API pagination", () => {
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
