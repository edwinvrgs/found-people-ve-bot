import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseVenezuelaTeBuscaPage, scrapeApiSource, searchKnownFoundPersonSources, shouldStopApiPagination } from "./known-sources.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Known found-person source ingestion", () => {
  it("queries known source URLs directly", async () => {
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
    assert.deepEqual(new Set(requestedUrls.map((url) => new URL(url).hostname)), new Set([
      "venezuelatebusca.com",
      "desaparecidos-terremoto-api.theempire.tech",
      "encuentralos.tecnosoft.dev",
    ]));
    assert.equal(requestedUrls.some((url) => url.includes("venezuelatebusca.com")), true);
    assert.equal(requestedUrls.some((url) => url.includes("desaparecidos-terremoto-api.theempire.tech")), true);
    assert.equal(requestedUrls.some((url) => url.includes("encuentralos.tecnosoft.dev")), true);
  });
});

describe("VenezuelaTeBusca page parsing", () => {
  it("uses a unique source URL per person instead of one shared page URL", () => {
    const html = `
      <html><body>
        Registrar persona
        Localizada Ana Maria Perez 24 años femenino 25 jun. 2026 hospital central
        Localizada Carlos Jose Rivas 41 años masculino 25 jun. 2026 refugio municipal
        Cargar más
      </body></html>`;

    const result = parseVenezuelaTeBuscaPage(html, 7);

    assert.equal(result.candidates.length, 2);
    assert.equal(new Set(result.candidates.map((candidate) => candidate.sourceUrl)).size, 2);
    assert.equal(result.candidates.every((candidate) => candidate.sourceUrl.startsWith("https://venezuelatebusca.com/?status=found&page=7#record=")), true);
    assert.equal(result.candidates.every((candidate) => /^[a-f0-9]{64}$/.test(candidate.sourceHash)), true);
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
