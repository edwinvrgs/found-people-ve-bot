export type FoundPersonCandidate = {
  fullName: string;
  relevantInfo: string | null;
  sourceUrl: string;
  documentId?: string | null;
  raw?: Record<string, unknown>;
};

export type SearchCandidateInput = FoundPersonCandidate & {
  sourceHash: string;
  raw?: Record<string, unknown>;
};

export type RejectedSearchCandidate = {
  provider: "socialcrawl";
  query: string;
  reason: string;
  url: string | null;
  title: string | null;
  text: string | null;
};

export type SearchProviderResult = {
  candidates: SearchCandidateInput[];
  errors: string[];
  rejected?: RejectedSearchCandidate[];
};

export type IngestionSource = {
  name: string;
  enabled?: boolean;
  disabledReason?: string;
  search: (signal: AbortSignal) => Promise<SearchProviderResult>;
};

export type PublicFoundPerson = {
  fullName: string;
  relevantInfo: string | null;
  sourceUrl: string;
};
