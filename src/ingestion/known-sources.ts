import { createHash } from "node:crypto";
import { extractDocumentId, sanitizeRelevantInfo } from "./sanitize.js";
import type { SearchCandidateInput } from "./search-provider.js";

const VENEZUELA_TE_BUSCA_URL = "https://venezuelatebusca.com/";
const DESAPARECIDOS_API_URL = "https://desaparecidos-terremoto-api.theempire.tech/api/personas";
const ENCUENTRALOS_API_URL = "https://encuentralos.tecnosoft.dev/api/personas";

const VENEZUELA_TE_BUSCA_PAGE_LIMIT = 250;
const API_PAGE_LIMIT = 250;
const API_PAGE_DELAY_MS = 650;
const API_PAGE_SIZE = 100;

type ApiPerson = {
  id?: unknown;
  nombre?: unknown;
  edad?: unknown;
  ubicacion?: unknown;
  fecha?: unknown;
  descripcion?: unknown;
  estado?: unknown;
  localizadoPor?: unknown;
  localizadoRelacion?: unknown;
  localizadoNota?: unknown;
  updatedAt?: unknown;
};

type ApiPeopleResponse = {
  items?: ApiPerson[];
  totalPages?: number;
};

type SourceName = "venezuelatebusca" | "desaparecidos_terremoto" | "encuentralos";

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  return signal?.aborted || (error instanceof Error && error.name === "AbortError");
}

function retryAfterMs(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 5_000;
}

function asString(value: unknown) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function textFromHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isClearlyBadName(name: string) {
  const cleaned = name.trim();
  if (cleaned.length < 5 || cleaned.length > 120) return true;
  if (/https?:|www\.|@|#|\p{Extended_Pictographic}/iu.test(cleaned)) return true;
  if (/\d/.test(cleaned)) return true;
  if (/\b(test|trusted|oracle|infinityhotel|ayudemos|no se|no sé)\b/iu.test(cleaned)) return true;
  return cleaned.split(/\s+/).filter(Boolean).length < 2;
}

function candidate(source: SourceName, id: string, fullName: string, relevantInfo: string, sourceUrl: string, raw: Record<string, unknown>, documentValue?: string | null): SearchCandidateInput | null {
  const normalizedName = fullName.replace(/\s+/g, " ").trim();
  if (isClearlyBadName(normalizedName)) return null;

  return {
    fullName: normalizedName,
    relevantInfo: sanitizeRelevantInfo(relevantInfo),
    sourceUrl,
    documentId: extractDocumentId(documentValue ?? relevantInfo),
    sourceHash: createHash("sha256").update(`${source}:${id}:${normalizedName}`).digest("hex"),
    raw: { provider: source, source, ...raw },
  };
}

export function parseVenezuelaTeBuscaPage(html: string, page: number) {
  const text = textFromHtml(html);
  const hasMore = /Cargar más/u.test(text);
  const section = text.match(/Registrar persona(.+?)(?:Cargar más|🇻🇪Venezuela te busca|Venezuela te busca|$)/u)?.[1] ?? "";
  const chunks = section.split(/(?=Localizada)/u).filter((chunk) => chunk.startsWith("Localizada"));
  const candidates: SearchCandidateInput[] = [];

  chunks.forEach((chunk, index) => {
    let cleaned = chunk.replace(/^Localizada/u, "").trim();
    const statusFlags = ["Localizada"];
    for (const flag of ["Hospitalizada", "Fallecida"]) {
      if (cleaned.toLocaleLowerCase("es-VE").startsWith(flag.toLocaleLowerCase("es-VE"))) {
        statusFlags.push(flag);
        cleaned = cleaned.slice(flag.length).trim();
      }
    }

    const marker = cleaned.match(/(?=\d{1,3}\s+años\b|\d[\d.]{4,}\s+-\s*|\b(?:femenino|masculino|otro)\b|\d{1,2}\s+jun\.\s+2026)/iu);
    if (!marker || marker.index === undefined) return;

    const fullName = cleaned.slice(0, marker.index).trim();
    const details = cleaned.slice(marker.index).trim();
    const recordId = createHash("sha256").update(`${fullName}:${details}`).digest("hex").slice(0, 16);
    const sourceUrl = `${VENEZUELA_TE_BUSCA_URL}?status=found&page=${page}#record=${recordId}`;
    const id = recordId;
    const item = candidate(
      "venezuelatebusca",
      id,
      fullName,
      `VenezuelaTeBusca · ${statusFlags.join(" · ")} · ${details}`,
      sourceUrl,
      { page, index, details },
      details,
    );
    if (item) candidates.push(item);
  });

  return { candidates, hasMore };
}

async function scrapeVenezuelaTeBusca(enabled: boolean, signal?: AbortSignal) {
  if (!enabled) return { candidates: [], errors: [] };

  const candidates: SearchCandidateInput[] = [];
  const errors: string[] = [];
  const seenPageSignatures = new Set<string>();

  for (let page = 1; page <= VENEZUELA_TE_BUSCA_PAGE_LIMIT; page += 1) {
    throwIfAborted(signal);
    const url = new URL(VENEZUELA_TE_BUSCA_URL);
    url.searchParams.set("status", "found");
    url.searchParams.set("page", String(page));

    try {
      const response = await fetch(url, { headers: { Accept: "text/html" }, signal });
      if (!response.ok) {
        errors.push(`venezuelatebusca page ${page}: ${response.status}`);
        continue;
      }
      const parsed = parseVenezuelaTeBuscaPage(await response.text(), page);
      if (parsed.candidates.length === 0) break;

      const pageSignature = parsed.candidates.map((item) => item.sourceHash).join(":");
      if (seenPageSignatures.has(pageSignature)) break;
      seenPageSignatures.add(pageSignature);

      candidates.push(...parsed.candidates);
      if (!parsed.hasMore) break;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      errors.push(`venezuelatebusca page ${page}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return { candidates, errors };
}

function apiPersonToCandidate(source: Extract<SourceName, "desaparecidos_terremoto" | "encuentralos">, baseUrl: string, person: ApiPerson) {
  const id = asString(person.id);
  const fullName = asString(person.nombre);
  if (!id || !fullName) return null;

  const estado = asString(person.estado);
  if (estado !== "localizado") return null;

  const fields = [
    "Localizado",
    asString(person.edad) ? `edad: ${asString(person.edad)}` : "",
    asString(person.ubicacion) ? `ubicación: ${asString(person.ubicacion)}` : "",
    asString(person.fecha) ? `fecha: ${asString(person.fecha)}` : "",
    asString(person.descripcion) ? `descripción: ${asString(person.descripcion)}` : "",
    asString(person.localizadoPor) ? `localizado por: ${asString(person.localizadoPor)}` : "",
    asString(person.localizadoRelacion) ? `relación: ${asString(person.localizadoRelacion)}` : "",
    asString(person.localizadoNota) ? `nota: ${asString(person.localizadoNota)}` : "",
  ].filter(Boolean).join(" · ");

  return candidate(source, id, fullName, `${source === "encuentralos" ? "Encuéntralos" : "Desaparecidos Terremoto Venezuela"} · ${fields}`, `${baseUrl}?persona=${encodeURIComponent(id)}`, { id, estado, updatedAt: person.updatedAt ?? null }, [asString(person.descripcion), asString(person.localizadoNota)].join(" "));
}

export function shouldStopApiPagination(status: number) {
  return status === 401 || status === 403 || status === 429;
}

export async function scrapeApiSource(source: Extract<SourceName, "desaparecidos_terremoto" | "encuentralos">, apiUrl: string, publicUrl: string, enabled: boolean, signal?: AbortSignal) {
  if (!enabled) return { candidates: [], errors: [] };

  const candidates: SearchCandidateInput[] = [];
  const errors: string[] = [];
  const seenPageSignatures = new Set<string>();

  for (let page = 1; page <= API_PAGE_LIMIT; page += 1) {
    throwIfAborted(signal);
    if (page > 1) await sleep(API_PAGE_DELAY_MS, signal);

    const url = new URL(apiUrl);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(API_PAGE_SIZE));
    url.searchParams.set("estado", "localizado");

    try {
      let response = await fetch(url, { headers: { Accept: "application/json" }, signal });
      if (response.status === 429) {
        await sleep(retryAfterMs(response), signal);
        response = await fetch(url, { headers: { Accept: "application/json" }, signal });
      }
      if (!response.ok) {
        errors.push(`${source} page ${page}: ${response.status}`);
        if (shouldStopApiPagination(response.status)) break;
        continue;
      }
      const body = (await response.json().catch(() => ({}))) as ApiPeopleResponse;
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) break;

      const pageCandidates: SearchCandidateInput[] = [];
      for (const person of items) {
        const item = apiPersonToCandidate(source, publicUrl, person);
        if (item) pageCandidates.push(item);
      }

      const pageSignature = pageCandidates.map((item) => item.sourceHash).join(":");
      if (pageSignature && seenPageSignatures.has(pageSignature)) break;
      if (pageSignature) seenPageSignatures.add(pageSignature);

      candidates.push(...pageCandidates);
      if (body.totalPages && page >= body.totalPages) break;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      errors.push(`${source} page ${page}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return { candidates, errors };
}

export async function searchKnownFoundPersonSources(signal?: AbortSignal): Promise<{ candidates: SearchCandidateInput[]; errors: string[] }> {
  const [venezuelaTeBusca, desaparecidos, encuentralos] = await Promise.all([
    scrapeVenezuelaTeBusca(true, signal),
    scrapeApiSource("desaparecidos_terremoto", DESAPARECIDOS_API_URL, "https://desaparecidosterremotovenezuela.com/", true, signal),
    scrapeApiSource("encuentralos", ENCUENTRALOS_API_URL, "https://encuentralos.tecnosoft.dev/", true, signal),
  ]);

  return {
    candidates: [...venezuelaTeBusca.candidates, ...desaparecidos.candidates, ...encuentralos.candidates],
    errors: [...venezuelaTeBusca.errors, ...desaparecidos.errors, ...encuentralos.errors],
  };
}
