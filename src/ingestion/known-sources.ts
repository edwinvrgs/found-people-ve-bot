import { createHash } from "node:crypto";
import { extractDocumentId, sanitizeRelevantInfo } from "./sanitize.js";
import type { SearchCandidateInput } from "./types.js";

const VENEZUELA_TE_BUSCA_URL = "https://venezuelatebusca.com/";
const DESAPARECIDOS_API_URL = "https://desaparecidos-terremoto-api.theempire.tech/api/personas";
const ENCUENTRALOS_API_URL = "https://encuentralos.tecnosoft.dev/api/personas";
const DESAPARECIDOS_VENEZUELA_API_URL = "https://www.desaparecidosvenezuela.com/api/personas";
const DESAPARECIDOS_VENEZUELA_PUBLIC_URL = "https://www.desaparecidosvenezuela.com/";
const SOS_VENEZUELA_API_URL = "https://sosvenezuela2026.com/api/persons/list";
const SOS_VENEZUELA_PUBLIC_URL = "https://sosvenezuela2026.com/";

const VENEZUELA_TE_BUSCA_PAGE_LIMIT = 250;
const API_PAGE_LIMIT = 250;
const SLOW_API_PAGE_DELAY_MS = 650;
const API_PAGE_SIZE = 100;

type ApiPerson = {
  id?: unknown;
  nombre?: unknown;
  edad?: unknown;
  ubicacion?: unknown;
  ultima_ubicacion?: unknown;
  fecha?: unknown;
  descripcion?: unknown;
  estado?: unknown;
  localizadoPor?: unknown;
  localizadoRelacion?: unknown;
  localizadoNota?: unknown;
  pv_por?: unknown;
  pv_lugar?: unknown;
  pv_salud?: unknown;
  pv_relacion?: unknown;
  cedula?: unknown;
  updatedAt?: unknown;
  creado?: unknown;
};

type ApiPeopleResponse = {
  items?: ApiPerson[];
  total?: number;
  totalPages?: number;
};

type DesaparecidosVenezuelaPerson = {
  id?: unknown;
  nombre?: unknown;
  edad?: unknown;
  zona?: unknown;
  descripcion?: unknown;
  estado?: unknown;
  tipo?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  actualizaciones?: unknown;
};

type SosVenezuelaPerson = {
  id?: unknown;
  status?: unknown;
  cedula_masked?: unknown;
  display_name?: unknown;
  municipio?: unknown;
  parroquia?: unknown;
  hospital_name?: unknown;
  source_date?: unknown;
};

type SourceName = "venezuelatebusca" | "desaparecidos_terremoto" | "encuentralos" | "desaparecidos_venezuela" | "sos_venezuela_2026";

type FoundPersonSourceAdapter = {
  name: SourceName;
  search(signal?: AbortSignal): Promise<{ candidates: SearchCandidateInput[]; errors: string[] }>;
};

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
  const isFound = source === "encuentralos" ? estado === "encontrado" : estado === "localizado";
  if (!isFound) return null;

  const fields = [
    "Localizado",
    asString(person.edad) ? `edad: ${asString(person.edad)}` : "",
    asString(person.ubicacion || person.ultima_ubicacion) ? `ubicación: ${asString(person.ubicacion || person.ultima_ubicacion)}` : "",
    asString(person.fecha || person.creado) ? `fecha: ${asString(person.fecha || person.creado)}` : "",
    asString(person.descripcion) ? `descripción: ${asString(person.descripcion)}` : "",
    asString(person.localizadoPor || person.pv_por) ? `localizado por: ${asString(person.localizadoPor || person.pv_por)}` : "",
    asString(person.localizadoRelacion || person.pv_relacion) ? `relación: ${asString(person.localizadoRelacion || person.pv_relacion)}` : "",
    asString(person.localizadoNota || person.pv_salud) ? `nota: ${asString(person.localizadoNota || person.pv_salud)}` : "",
    asString(person.pv_lugar) ? `lugar: ${asString(person.pv_lugar)}` : "",
  ].filter(Boolean).join(" · ");

  const sourceUrl = source === "encuentralos" ? `${baseUrl.replace(/\/$/, "")}/p/${encodeURIComponent(id)}` : `${baseUrl}?persona=${encodeURIComponent(id)}`;
  const documentText = [asString(person.cedula), asString(person.descripcion), asString(person.localizadoNota), asString(person.pv_salud)].join(" ");

  return candidate(source, id, fullName, `${source === "encuentralos" ? "Encuéntralos" : "Desaparecidos Terremoto Venezuela"} · ${fields}`, sourceUrl, { id, estado, updatedAt: person.updatedAt ?? person.creado ?? null }, documentText);
}

export function desaparecidosVenezuelaPersonToCandidate(person: DesaparecidosVenezuelaPerson) {
  const id = asString(person.id);
  const fullName = asString(person.nombre);
  const estado = asString(person.estado).toUpperCase();
  if (!id || !fullName || !["ENCONTRADO", "SANO_SALVO"].includes(estado)) return null;

  const fields = [
    estado === "SANO_SALVO" ? "Sano y salvo" : "Encontrado",
    asString(person.edad) ? `edad: ${asString(person.edad)}` : "",
    asString(person.zona) ? `zona: ${asString(person.zona)}` : "",
    asString(person.descripcion) ? `descripción: ${asString(person.descripcion)}` : "",
    asString(person.tipo) ? `tipo: ${asString(person.tipo)}` : "",
    asString(person.updatedAt || person.createdAt) ? `fecha: ${asString(person.updatedAt || person.createdAt)}` : "",
  ].filter(Boolean).join(" · ");

  return candidate(
    "desaparecidos_venezuela",
    id,
    fullName,
    `Desaparecidos Venezuela · ${fields}`,
    `${DESAPARECIDOS_VENEZUELA_PUBLIC_URL}p/${encodeURIComponent(id)}`,
    { id, estado, tipo: person.tipo ?? null, updatedAt: person.updatedAt ?? null, createdAt: person.createdAt ?? null },
    [asString(person.descripcion), asString(person.zona)].join(" "),
  );
}

export function sosVenezuelaPersonToCandidate(person: SosVenezuelaPerson) {
  const id = asString(person.id);
  const fullName = asString(person.display_name);
  const status = asString(person.status);
  if (!id || !fullName || status !== "found_alive") return null;

  const fields = [
    "Localizado con vida",
    asString(person.hospital_name) ? `hospital: ${asString(person.hospital_name)}` : "",
    asString(person.parroquia) ? `parroquia: ${asString(person.parroquia)}` : "",
    asString(person.municipio) ? `municipio: ${asString(person.municipio)}` : "",
    asString(person.source_date) ? `fecha: ${asString(person.source_date)}` : "",
  ].filter(Boolean).join(" · ");

  return candidate(
    "sos_venezuela_2026",
    id,
    fullName,
    `SOS Venezuela 2026 · ${fields}`,
    `${SOS_VENEZUELA_PUBLIC_URL}buscar?estado=found_alive#person=${encodeURIComponent(id)}`,
    { id, status, source_date: person.source_date ?? null },
    asString(person.cedula_masked),
  );
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
    const pageDelayMs = apiPageDelayMs(source);
    if (page > 1 && pageDelayMs > 0) await sleep(pageDelayMs, signal);

    const url = new URL(apiUrl);
    if (source === "encuentralos") {
      url.searchParams.set("limit", String(API_PAGE_SIZE));
      url.searchParams.set("offset", String((page - 1) * API_PAGE_SIZE));
      url.searchParams.set("estado", "encontrado");
    } else {
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(API_PAGE_SIZE));
      url.searchParams.set("estado", "localizado");
    }

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
      if (source === "encuentralos") {
        const total = typeof body.total === "number" && Number.isFinite(body.total) ? body.total : null;
        if (items.length < API_PAGE_SIZE || (total !== null && page * API_PAGE_SIZE >= total)) break;
      }
      if (body.totalPages && page >= body.totalPages) break;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      errors.push(`${source} page ${page}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return { candidates, errors };
}

export async function scrapeDesaparecidosVenezuelaSource(apiUrl: string, enabled: boolean, signal?: AbortSignal) {
  if (!enabled) return { candidates: [], errors: [] };

  const candidates: SearchCandidateInput[] = [];
  const errors: string[] = [];

  for (const estado of ["ENCONTRADO", "SANO_SALVO"]) {
    throwIfAborted(signal);
    const url = new URL(apiUrl);
    url.searchParams.set("estado", estado);

    try {
      let response = await fetch(url, { headers: { Accept: "application/json" }, signal });
      if (response.status === 429) {
        await sleep(retryAfterMs(response), signal);
        response = await fetch(url, { headers: { Accept: "application/json" }, signal });
      }
      if (!response.ok) {
        errors.push(`desaparecidos_venezuela ${estado}: ${response.status}`);
        if (shouldStopApiPagination(response.status)) break;
        continue;
      }

      const body = (await response.json().catch(() => [])) as unknown;
      const items = Array.isArray(body) ? body : [];
      for (const person of items) {
        const item = desaparecidosVenezuelaPersonToCandidate(person as DesaparecidosVenezuelaPerson);
        if (item) candidates.push(item);
      }
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      errors.push(`desaparecidos_venezuela ${estado}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return { candidates, errors };
}

export async function scrapeSosVenezuelaSource(apiUrl: string, enabled: boolean, signal?: AbortSignal) {
  if (!enabled) return { candidates: [], errors: [] };

  const candidates: SearchCandidateInput[] = [];
  const errors: string[] = [];
  const seenPageSignatures = new Set<string>();

  for (let page = 1; page <= API_PAGE_LIMIT; page += 1) {
    throwIfAborted(signal);
    const url = new URL(apiUrl);
    url.searchParams.set("estado", "found_alive");
    url.searchParams.set("limit", String(API_PAGE_SIZE));
    url.searchParams.set("offset", String((page - 1) * API_PAGE_SIZE));

    try {
      let response = await fetch(url, { headers: { Accept: "application/json" }, signal });
      if (response.status === 429) {
        await sleep(retryAfterMs(response), signal);
        response = await fetch(url, { headers: { Accept: "application/json" }, signal });
      }
      if (!response.ok) {
        errors.push(`sos_venezuela_2026 page ${page}: ${response.status}`);
        if (shouldStopApiPagination(response.status)) break;
        continue;
      }

      const body = (await response.json().catch(() => [])) as unknown;
      const items = Array.isArray(body) ? body : [];
      if (items.length === 0) break;

      const pageCandidates = items.map((person) => sosVenezuelaPersonToCandidate(person as SosVenezuelaPerson)).filter((item) => item !== null);
      const pageSignature = pageCandidates.map((item) => item.sourceHash).join(":");
      if (pageSignature && seenPageSignatures.has(pageSignature)) break;
      if (pageSignature) seenPageSignatures.add(pageSignature);

      candidates.push(...pageCandidates);
      if (items.length < API_PAGE_SIZE) break;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      errors.push(`sos_venezuela_2026 page ${page}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return { candidates, errors };
}

function apiPageDelayMs(source: Extract<SourceName, "desaparecidos_terremoto" | "encuentralos">) {
  return source === "encuentralos" ? 0 : SLOW_API_PAGE_DELAY_MS;
}

export async function searchKnownFoundPersonSources(signal?: AbortSignal): Promise<{ candidates: SearchCandidateInput[]; errors: string[] }> {
  const adapters: FoundPersonSourceAdapter[] = [
    { name: "venezuelatebusca", search: (sourceSignal) => scrapeVenezuelaTeBusca(true, sourceSignal) },
    { name: "desaparecidos_terremoto", search: (sourceSignal) => scrapeApiSource("desaparecidos_terremoto", DESAPARECIDOS_API_URL, "https://desaparecidosterremotovenezuela.com/", true, sourceSignal) },
    { name: "encuentralos", search: (sourceSignal) => scrapeApiSource("encuentralos", ENCUENTRALOS_API_URL, "https://encuentralos.tecnosoft.dev/", true, sourceSignal) },
    { name: "desaparecidos_venezuela", search: (sourceSignal) => scrapeDesaparecidosVenezuelaSource(DESAPARECIDOS_VENEZUELA_API_URL, true, sourceSignal) },
    { name: "sos_venezuela_2026", search: (sourceSignal) => scrapeSosVenezuelaSource(SOS_VENEZUELA_API_URL, true, sourceSignal) },
  ];

  const results = await Promise.all(adapters.map((adapter) => adapter.search(signal)));

  return {
    candidates: results.flatMap((result) => result.candidates),
    errors: results.flatMap((result) => result.errors),
  };
}
