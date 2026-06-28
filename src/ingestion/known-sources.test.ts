import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { busquedaVzlaReportToCandidate, desaparecidosVenezuelaPersonToCandidate, parseVenezuelaTeBuscaPage, scrapeApiSource, scrapeBusquedaVzlaSource, scrapeDesaparecidosVenezuelaSource, scrapeSosVenezuelaSource, searchKnownFoundPersonSources, shouldStopApiPagination, sosVenezuelaPersonToCandidate } from "./known-sources.js";

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
      if (url.includes("desaparecidosvenezuela.com")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("sosvenezuela2026.com")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("busquedavzla.netlify.app")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await searchKnownFoundPersonSources();

    assert.equal(result.errors.length, 0);
    assert.deepEqual(new Set(requestedUrls.map((url) => new URL(url).hostname)), new Set([
      "venezuelatebusca.com",
      "desaparecidos-terremoto-api.theempire.tech",
      "encuentralos.tecnosoft.dev",
      "www.desaparecidosvenezuela.com",
      "sosvenezuela2026.com",
      "busquedavzla.netlify.app",
    ]));
    assert.equal(requestedUrls.some((url) => url.includes("venezuelatebusca.com")), true);
    assert.equal(requestedUrls.some((url) => url.includes("desaparecidos-terremoto-api.theempire.tech")), true);
    assert.equal(requestedUrls.some((url) => url.includes("encuentralos.tecnosoft.dev")), true);
    assert.equal(requestedUrls.some((url) => url.includes("desaparecidosvenezuela.com/api/personas")), true);
    assert.equal(requestedUrls.some((url) => url.includes("sosvenezuela2026.com/api/persons/list")), true);
    assert.equal(requestedUrls.some((url) => url.includes("busquedavzla.netlify.app/api/reports")), true);
  });
});

describe("Busqueda VZLA ingestion", () => {
  it("maps only localized reports and strips photo/reporter payloads", () => {
    const candidate = busquedaVzlaReportToCandidate({
      id: "mqx6i0i9-5jx5kcgk",
      nombre: "Ysmael Peña Pérez",
      apodo: "Ysmael",
      edad: "37",
      estado: "localizada",
      estadoUb: "Hospital Central",
      referencia: "La Guaira",
      visto: "24 de Junio",
      ts: 1782614252855,
      foto: "data:image/jpeg;base64,abc",
      repTel: "04120000000",
      repEmail: "test@example.com",
    });

    assert.equal(candidate?.fullName, "Ysmael Peña Pérez");
    assert.equal(candidate?.sourceUrl, "https://busquedavzla.netlify.app/#report=mqx6i0i9-5jx5kcgk");
    assert.equal(candidate?.raw?.provider, "busqueda_vzla");
    assert.equal("foto" in (candidate?.raw ?? {}), false);
    assert.equal("repTel" in (candidate?.raw ?? {}), false);
    assert.equal("repEmail" in (candidate?.raw ?? {}), false);
    assert.match(candidate?.relevantInfo ?? "", /Localizada/u);
    assert.equal(busquedaVzlaReportToCandidate({ id: "1", nombre: "Persona Buscada", estado: "buscando" }), null);
    assert.equal(busquedaVzlaReportToCandidate({ id: "2", nombre: "Persona Sin Contacto", estado: "sincontacto" }), null);
  });

  it("reads the public reports list once and keeps only localized reports", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify([
        { id: "found", nombre: "Persona Localizada", estado: "localizada" },
        { id: "missing", nombre: "Persona Buscada", estado: "buscando" },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await scrapeBusquedaVzlaSource("https://busquedavzla.netlify.app/api/reports", true);

    assert.deepEqual(requestedUrls, ["https://busquedavzla.netlify.app/api/reports"]);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.errors, []);
  });
});

describe("Desaparecidos Venezuela ingestion", () => {
  it("maps only found/safe statuses and omits sensitive update/contact payloads", () => {
    const candidate = desaparecidosVenezuelaPersonToCandidate({
      id: "cmqvjm2l9000k3aqpji1om9q4",
      nombre: "Rosmar Perez",
      edad: 33,
      zona: "La Guaira · Naiguatá",
      descripcion: "Está bien",
      estado: "ENCONTRADO",
      tipo: "VI_A_ALGUIEN",
      updatedAt: "2026-06-26T23:11:16.314Z",
      actualizaciones: [{ contacto: "04120000000" }],
    });

    assert.equal(candidate?.fullName, "Rosmar Perez");
    assert.equal(candidate?.sourceUrl, "https://www.desaparecidosvenezuela.com/p/cmqvjm2l9000k3aqpji1om9q4");
    assert.equal(candidate?.raw?.provider, "desaparecidos_venezuela");
    assert.equal("actualizaciones" in (candidate?.raw ?? {}), false);
    assert.match(candidate?.relevantInfo ?? "", /Encontrado/u);
    assert.match(candidate?.sourceHash ?? "", /^[a-f0-9]{64}$/u);

    assert.equal(desaparecidosVenezuelaPersonToCandidate({ id: "1", nombre: "Persona Buscada", estado: "BUSCADO" }), null);
    assert.equal(desaparecidosVenezuelaPersonToCandidate({ id: "2", nombre: "Persona Info", estado: "INFO_RECIBIDA" }), null);
  });

  it("queries only ENCONTRADO and SANO_SALVO statuses", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(String(input));
      const estado = new URL(String(input)).searchParams.get("estado");
      return new Response(JSON.stringify([{ id: `id-${estado}`, nombre: "Persona Localizada", estado }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await scrapeDesaparecidosVenezuelaSource("https://www.desaparecidosvenezuela.com/api/personas", true);

    assert.deepEqual(requestedUrls.map((url) => new URL(url).searchParams.get("estado")), ["ENCONTRADO", "SANO_SALVO"]);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.errors, []);
  });
});

describe("SOS Venezuela 2026 ingestion", () => {
  it("maps only found_alive records from the public aggregator", () => {
    const candidate = sosVenezuelaPersonToCandidate({
      id: "1663daa6-f1b7-4ef2-becd-580e2bf2f15f",
      status: "found_alive",
      cedula_masked: "V-****815",
      display_name: "Amairyn Pérez",
      hospital_name: "Hospital Central",
      source_date: "2026-06-27T20:15:06.986Z",
    });

    assert.equal(candidate?.fullName, "Amairyn Pérez");
    assert.equal(candidate?.sourceUrl, "https://sosvenezuela2026.com/buscar?estado=found_alive#person=1663daa6-f1b7-4ef2-becd-580e2bf2f15f");
    assert.equal(candidate?.documentId, null);
    assert.equal(candidate?.raw?.provider, "sos_venezuela_2026");
    assert.match(candidate?.relevantInfo ?? "", /Localizado con vida/u);
    assert.equal(sosVenezuelaPersonToCandidate({ id: "missing", display_name: "Persona Buscada", status: "seeking_info" }), null);
  });

  it("uses found_alive offset pagination and stops on a partial page", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(String(input));
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return new Response(JSON.stringify(Array.from({ length: offset === 0 ? 100 : 1 }, (_, index) => ({
        id: `person-${offset}-${index}`,
        status: "found_alive",
        display_name: "Persona Localizada",
      }))), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await scrapeSosVenezuelaSource("https://sosvenezuela2026.com/api/persons/list", true);

    assert.equal(requestedUrls.length, 2);
    assert.equal(new URL(requestedUrls[0]).searchParams.get("estado"), "found_alive");
    assert.equal(new URL(requestedUrls[0]).searchParams.get("limit"), "100");
    assert.equal(new URL(requestedUrls[0]).searchParams.get("offset"), "0");
    assert.equal(new URL(requestedUrls[1]).searchParams.get("offset"), "100");
    assert.equal(result.candidates.length, 101);
    assert.deepEqual(result.errors, []);
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

  it("queries Encuentralos with its public estado and offset pagination", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({
        items: [{
          id: "413c9ded-6def-4bd0-95bd-41bf92d65549",
          nombre: "Anneliese Mayorca",
          edad: 63,
          ultima_ubicacion: "Caracas Hatillo",
          estado: "encontrado",
          pv_por: "venezuelatebusca.com",
          pv_salud: "Localizada",
          cedula: "V-12.345.678",
          creado: "2026-06-26T19:33:06.759Z",
        }],
        total: 1,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await scrapeApiSource(
      "encuentralos",
      "https://encuentralos.tecnosoft.dev/api/personas",
      "https://encuentralos.tecnosoft.dev/",
      true,
    );

    assert.equal(requestedUrls.length, 1);
    const url = new URL(requestedUrls[0]);
    assert.equal(url.searchParams.get("estado"), "encontrado");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("offset"), "0");
    assert.equal(url.searchParams.has("page"), false);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].sourceUrl, "https://encuentralos.tecnosoft.dev/p/413c9ded-6def-4bd0-95bd-41bf92d65549");
    assert.equal(result.candidates[0].documentId, "12345678");
  });

  it("does not add the slow-source page delay to Encuentralos offset pagination", async () => {
    const requestedUrls: string[] = [];
    const startedAt = Date.now();

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requestedUrls.push(String(input));
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      const itemCount = offset === 0 ? 100 : 1;
      return new Response(JSON.stringify({
        items: Array.from({ length: itemCount }, (_, index) => ({
          id: `person-${offset}-${index}`,
          nombre: "Persona Encontrada",
          estado: "encontrado",
        })),
        total: 101,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await scrapeApiSource(
      "encuentralos",
      "https://encuentralos.tecnosoft.dev/api/personas",
      "https://encuentralos.tecnosoft.dev/",
      true,
    );

    assert.equal(requestedUrls.length, 2);
    assert.equal(Date.now() - startedAt < 200, true);
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
