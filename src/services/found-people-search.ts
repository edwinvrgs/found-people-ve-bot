export type FoundPeopleSearchCriteria = {
  name?: string;
  documentId?: string;
};

export type FoundPeopleSearchInput = FoundPeopleSearchCriteria & {
  q?: string;
};

const DOCUMENT_FRAGMENT_PATTERN = /\b(?:[VEJPG]-?\s*)?\d[\d.\-\s]{4,}\d/gi;

export function normalizeSearchText(value: string | null | undefined) {
  const normalized = (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

export function normalizeDocumentId(value: string | null | undefined) {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 9 ? digits : undefined;
}

function removeDocumentFragments(value: string) {
  return value.replace(DOCUMENT_FRAGMENT_PATTERN, " ").replace(/\s+/g, " ").trim();
}

export function buildFoundPeopleSearchCriteria(input: FoundPeopleSearchInput): FoundPeopleSearchCriteria {
  const explicitName = normalizeSearchText(input.name);
  const explicitDocumentId = normalizeDocumentId(input.documentId);
  const q = normalizeSearchText(input.q);
  const qDocumentId = q ? normalizeDocumentId(q) : undefined;
  const qName = q ? normalizeSearchText(removeDocumentFragments(q)) : undefined;

  return {
    ...(explicitName ?? qName ? { name: explicitName ?? qName } : {}),
    ...(explicitDocumentId ?? qDocumentId ? { documentId: explicitDocumentId ?? qDocumentId } : {}),
  };
}

export function searchCriteriaKind(criteria: FoundPeopleSearchCriteria) {
  if (criteria.name && criteria.documentId) return "name_document";
  if (criteria.documentId) return "document";
  if (criteria.name) return "name";
  return "list";
}

export function searchCriteriaDisplay(criteria: FoundPeopleSearchCriteria, fallbackQuery: string) {
  if (criteria.name && criteria.documentId) return `“${criteria.name}” + cédula ${criteria.documentId}`;
  if (criteria.documentId) return `cédula ${criteria.documentId}`;
  if (criteria.name) return `“${criteria.name}”`;
  return `“${fallbackQuery}”`;
}
