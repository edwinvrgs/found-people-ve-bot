import { createHash } from "node:crypto";
import { errorDetails, logger } from "../logger.js";
import { buildFoundPersonSocialQueries } from "./queries.js";
import { extractFoundPerson, looksLikePersonName } from "./extract-person.js";
import { searchConsolidatedCandidates } from "./consolidated-source.js";
import { extractDocumentId, sanitizeRelevantInfo } from "./sanitize.js";
import { searchKnownFoundPersonSources } from "./known-sources.js";
import { runIngestionSources } from "./source-adapter.js";
import type { IngestionSource, RejectedSearchCandidate, SearchCandidateInput, SearchProviderResult } from "./types.js";

type SocialCrawlEnvelope = {
  success?: boolean;
  platform?: string;
  request_id?: string;
  data?: unknown;
  error?: { message?: string };
};

type CandidateSource = {
  provider: "socialcrawl";
  query: string;
  url: string;
  title: string | null;
  text: string | null;
  platform?: string | null;
  requestId?: string | null;
};

const SOCIALCRAWL_BASE_URL = "https://www.socialcrawl.dev/v1";
const SOCIAL_SOURCE_HOSTS = ["x.com", "twitter.com", "instagram.com", "facebook.com", "tiktok.com"];
const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export function canonicalizeSourceUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

export function hashSource(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSocialUrl(url: string) {
  const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  return SOCIAL_SOURCE_HOSTS.some((sourceHost) => host === sourceHost || host.endsWith(`.${sourceHost}`));
}

function toStringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function readPath(record: unknown, paths: string[][]) {
  for (const path of paths) {
    let current: unknown = record;
    for (const key of path) {
      if (!current || typeof current !== "object" || !(key in current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    const value = toStringValue(current);
    if (value) return value;
  }
  return null;
}

function findFirstUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return isHttpUrl(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findFirstUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["url", "post_url", "permalink", "link", "source_url"]) {
      const url = findFirstUrl(record[key]);
      if (url) return url;
    }
    for (const nested of Object.values(record)) {
      const url = findFirstUrl(nested);
      if (url) return url;
    }
  }
  return null;
}

function extractItems(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.results)) return record.results;
  if (Array.isArray(record.breakdown)) return record.breakdown;
  if (Array.isArray(record.posts)) return record.posts;
  return [];
}

function toCandidate(source: CandidateSource): SearchCandidateInput | RejectedSearchCandidate {
  const sourceUrl = canonicalizeSourceUrl(source.url);
  const rawRelevantInfo = [source.title, source.text].filter(Boolean).join(". ");
  const relevantInfo = sanitizeRelevantInfo(rawRelevantInfo);
  const fullName = extractFoundPerson(rawRelevantInfo).fullName;

  if (!fullName) return reject(source, "no_name_detected");
  if (!looksLikePersonName(fullName)) return reject(source, "invalid_name_shape");

  return {
    fullName,
    relevantInfo,
    sourceUrl,
    documentId: extractDocumentId(rawRelevantInfo),
    sourceHash: hashSource(`${sourceUrl}:${fullName}`),
    raw: {
      provider: source.provider,
      query: source.query,
      platform: source.platform ?? null,
      request_id: source.requestId ?? null,
    },
  };
}

function reject(source: Omit<CandidateSource, "url"> & { url?: string | null }, reason: string): RejectedSearchCandidate {
  return {
    provider: "socialcrawl",
    query: source.query,
    reason,
    url: source.url ?? null,
    title: source.title,
    text: source.text,
  };
}

function isRejected(candidate: SearchCandidateInput | RejectedSearchCandidate): candidate is RejectedSearchCandidate {
  return "reason" in candidate;
}

async function searchSocialCrawl(queryLimit: number, signal?: AbortSignal): Promise<SearchProviderResult> {
  if (queryLimit <= 0) return { candidates: [], errors: [], rejected: [] };
  const apiKey = process.env.SOCIALCRAWL_API_KEY;
  if (!apiKey) return { candidates: [], errors: ["SOCIALCRAWL_API_KEY is not configured; skipped social search"], rejected: [] };

  const candidates: SearchCandidateInput[] = [];
  const rejected: RejectedSearchCandidate[] = [];
  const errors: string[] = [];

  for (const query of buildFoundPersonSocialQueries(queryLimit)) {
    signal?.throwIfAborted();
    try {
      const url = new URL(`${SOCIALCRAWL_BASE_URL}/search/everywhere`);
      url.searchParams.set("query", query);
      url.searchParams.set("lookback_days", "30");
      url.searchParams.set("sources", "twitter,instagram,facebook,tiktok");

      const response = await fetch(url, {
        headers: { Accept: "application/json", "x-api-key": apiKey },
        signal,
      });
      const envelope = (await response.json().catch(() => ({}))) as SocialCrawlEnvelope;

      if (!response.ok || envelope.success === false) {
        errors.push(`${query}: SocialCrawl failed with ${response.status}${envelope.error?.message ? ` (${envelope.error.message})` : ""}`);
        continue;
      }

      for (const item of extractItems(envelope.data)) {
        const title = readPath(item, [["title"], ["post", "title"], ["author", "display_name"], ["post", "author", "display_name"]]);
        const text = readPath(item, [["text"], ["content"], ["description"], ["caption"], ["post", "content", "text"], ["post", "text"]]);
        const sourceUrl = findFirstUrl(item);

        if (!sourceUrl) {
          rejected.push(reject({ provider: "socialcrawl", query, title, text, platform: envelope.platform, requestId: envelope.request_id }, "no_url"));
          continue;
        }
        if (!isSocialUrl(sourceUrl)) {
          rejected.push(reject({ provider: "socialcrawl", query, url: sourceUrl, title, text, platform: envelope.platform, requestId: envelope.request_id }, "non_social_url"));
          continue;
        }

        const candidate = toCandidate({
          provider: "socialcrawl",
          query,
          url: sourceUrl,
          title,
          text,
          platform: envelope.platform,
          requestId: envelope.request_id,
        });

        if (isRejected(candidate)) rejected.push(candidate);
        else candidates.push(candidate);
      }
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      errors.push(`${query}: ${error instanceof Error ? error.message : "unknown SocialCrawl error"}`);
    }
  }

  return { candidates, errors, rejected };
}

export async function searchFoundPersonCandidates(queryLimit = 1): Promise<SearchProviderResult> {
  const providerTimeoutMs = configuredPositiveInt("FOUND_PEOPLE_PROVIDER_TIMEOUT_MS", DEFAULT_PROVIDER_TIMEOUT_MS);
  const socialSearchEnabled = isSocialCrawlIngestEnabled();
  const sources: IngestionSource[] = [
    {
      name: "socialcrawl",
      enabled: socialSearchEnabled,
      disabledReason: "FOUND_PEOPLE_SOCIALCRAWL_ENABLED is not true",
      search: (signal) => searchSocialCrawl(queryLimit, signal),
    },
    { name: "github_ocr_consolidated_csv", search: (signal) => searchConsolidatedCandidates(signal) },
    { name: "known_found_person_sources", search: (signal) => searchKnownFoundPersonSources(signal) },
  ];

  return runIngestionSources(
    sources,
    (name, search) => searchProvider(name, search, providerTimeoutMs),
    skippedProvider,
  );
}

function skippedProvider(provider: string, reason: string): SearchProviderResult {
  logger.info({ event: "ingest_provider_search_skipped", provider, reason }, "Found-person provider search skipped");
  return { candidates: [], errors: [] };
}

export async function searchProvider(name: string, search: (signal: AbortSignal) => Promise<SearchProviderResult>, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS) {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  logger.info({ event: "ingest_provider_search_started", provider: name, timeoutMs }, "Found-person provider search started");
  try {
    const searchPromise = search(controller.signal);
    searchPromise.catch(() => undefined);
    const timeoutPromise = new Promise<SearchProviderResult>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort(new Error(`${name} timed out after ${timeoutMs}ms`));
        resolve({ candidates: [], errors: [`${name}: timed out after ${timeoutMs}ms`] });
      }, timeoutMs);
    });
    const result = await Promise.race([searchPromise, timeoutPromise]);
    logger.info({
      event: result.errors.some((error) => error.includes("timed out after")) ? "ingest_provider_search_timed_out" : "ingest_provider_search_completed",
      provider: name,
      durationMs: Date.now() - startedAt,
      candidates: result.candidates.length,
      errors: result.errors.length,
      rejected: result.rejected?.length ?? 0,
    }, "Found-person provider search completed");
    return result;
  } catch (error) {
    logger.error({ event: "ingest_provider_search_failed", provider: name, durationMs: Date.now() - startedAt, ...errorDetails(error) }, "Found-person provider search failed");
    return { candidates: [], errors: [`${name}: ${error instanceof Error ? error.message : "unknown provider error"}`] };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  return signal?.aborted || (error instanceof Error && error.name === "AbortError");
}

function configuredPositiveInt(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function isSocialCrawlIngestEnabled() {
  return process.env.FOUND_PEOPLE_SOCIALCRAWL_ENABLED?.toLowerCase() === "true";
}
