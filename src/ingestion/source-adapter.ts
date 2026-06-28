import type { IngestionSource, SearchCandidateInput, SearchProviderResult } from "./types.js";

export type SourceRunner = (name: string, search: (signal: AbortSignal) => Promise<SearchProviderResult>) => Promise<SearchProviderResult>;
export type SourceSkipper = (name: string, reason: string) => SearchProviderResult;

export async function runIngestionSources(sources: IngestionSource[], runSource: SourceRunner, skipSource: SourceSkipper): Promise<SearchProviderResult> {
  const results = await Promise.all(sources.map((source) => {
    if (source.enabled === false) {
      return skipSource(source.name, source.disabledReason ?? "source disabled");
    }
    return runSource(source.name, source.search);
  }));

  return mergeSearchProviderResults(results);
}

export function mergeSearchProviderResults(results: SearchProviderResult[]): SearchProviderResult {
  const byHash = new Map<string, SearchCandidateInput>();
  for (const result of results) {
    for (const candidate of result.candidates) {
      byHash.set(candidate.sourceHash, candidate);
    }
  }

  return {
    candidates: [...byHash.values()],
    errors: results.flatMap((result) => result.errors),
    rejected: results.flatMap((result) => result.rejected ?? []),
  };
}
