export type DuplicateAuditRow = {
  id: string;
  fullName: string;
  documentId: string | null;
  sourceUrl: string;
  status: string;
  raw?: Record<string, unknown> | null;
  updatedAt?: string | Date | null;
};

export type DuplicatePersonSummary = {
  id: string;
  fullName: string;
  documentId: string | null;
  source: string;
  sourceUrl: string;
  status: string;
  updatedAt?: string | Date | null;
};

export type DuplicateCluster = {
  kind: "same_document_id" | "same_normalized_name";
  confidence: "high" | "medium" | "medium_low";
  key: string;
  size: number;
  sources: string[];
  docs?: string[];
  people: DuplicatePersonSummary[];
};

export type SimilarNamePair = {
  kind: "similar_name";
  confidence: "medium_high" | "medium";
  score: number;
  signature: string;
  people: [DuplicatePersonSummary, DuplicatePersonSummary];
};

export type DuplicateAuditReport = {
  generatedAt: string;
  mode: "read_only";
  totalVisibleRows: number;
  sourceCounts: Record<string, number>;
  summary: {
    sameDocumentClusters: number;
    sameDocumentRows: number;
    sameNormalizedNameClusters: number;
    sameNormalizedNameRows: number;
    highSimilarityPairs: number;
  };
  clusters: {
    sameDocumentId: DuplicateCluster[];
    sameNormalizedName: DuplicateCluster[];
    similarNamePairs: SimilarNamePair[];
  };
  truncated: {
    sameNormalizedName: number;
    similarNamePairs: number;
  };
};

export type DuplicateAuditOptions = {
  maxSameNameClusters?: number;
  maxSimilarNamePairs?: number;
  maxFuzzyGroupSize?: number;
  minSimilarity?: number;
};

const DEFAULT_MAX_SAME_NAME_CLUSTERS = 500;
const DEFAULT_MAX_SIMILAR_NAME_PAIRS = 1000;
const DEFAULT_MAX_FUZZY_GROUP_SIZE = 80;
const DEFAULT_MIN_SIMILARITY = 0.88;

export function buildDuplicateAuditReport(rows: DuplicateAuditRow[], options: DuplicateAuditOptions = {}): DuplicateAuditReport {
  const maxSameNameClusters = options.maxSameNameClusters ?? DEFAULT_MAX_SAME_NAME_CLUSTERS;
  const maxSimilarNamePairs = options.maxSimilarNamePairs ?? DEFAULT_MAX_SIMILAR_NAME_PAIRS;
  const maxFuzzyGroupSize = options.maxFuzzyGroupSize ?? DEFAULT_MAX_FUZZY_GROUP_SIZE;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const documentGroups = groupRows(rows.filter((row) => row.documentId), (row) => row.documentId!);
  const exactNameGroups = groupRows(rows.filter((row) => normalizeName(row.fullName)), (row) => normalizeName(row.fullName));
  const signatureGroups = groupRows(
    rows.filter((row) => nameSignature(row.fullName)),
    (row) => nameSignature(row.fullName)!,
  );

  const sameDocumentId = [...documentGroups.entries()]
    .filter(([, people]) => people.length > 1)
    .map(([documentId, people]) => buildCluster("same_document_id", "high", documentId, people))
    .sort(sortClusters);

  const sameNormalizedNameAll = [...exactNameGroups.entries()]
    .filter(([, people]) => people.length > 1)
    .map(([normalizedName, people]) => buildCluster(
      "same_normalized_name",
      people.some((person) => person.documentId) ? "medium" : "medium_low",
      normalizedName,
      people,
      [...new Set(people.map((person) => person.documentId).filter(Boolean) as string[])],
    ))
    .sort(sortClusters);

  const similarNamePairsAll: SimilarNamePair[] = [];
  for (const [signature, people] of signatureGroups) {
    if (people.length < 2 || people.length > maxFuzzyGroupSize) continue;
    for (let firstIndex = 0; firstIndex < people.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < people.length; secondIndex += 1) {
        const first = people[firstIndex]!;
        const second = people[secondIndex]!;
        if (first.documentId && second.documentId && first.documentId !== second.documentId) continue;

        const firstName = normalizeName(first.fullName);
        const secondName = normalizeName(second.fullName);
        if (!firstName || !secondName || firstName === secondName) continue;

        const score = nameSimilarity(firstName, secondName);
        if (score >= minSimilarity) {
          similarNamePairsAll.push({
            kind: "similar_name",
            confidence: score >= 0.94 ? "medium_high" : "medium",
            score: Number(score.toFixed(3)),
            signature,
            people: [summarizePerson(first), summarizePerson(second)],
          });
        }
      }
    }
  }
  similarNamePairsAll.sort((first, second) => second.score - first.score);

  return {
    generatedAt: new Date().toISOString(),
    mode: "read_only",
    totalVisibleRows: rows.length,
    sourceCounts: countBy(rows, sourceOf),
    summary: {
      sameDocumentClusters: sameDocumentId.length,
      sameDocumentRows: sameDocumentId.reduce((total, cluster) => total + cluster.size, 0),
      sameNormalizedNameClusters: sameNormalizedNameAll.length,
      sameNormalizedNameRows: sameNormalizedNameAll.reduce((total, cluster) => total + cluster.size, 0),
      highSimilarityPairs: similarNamePairsAll.length,
    },
    clusters: {
      sameDocumentId,
      sameNormalizedName: sameNormalizedNameAll.slice(0, maxSameNameClusters),
      similarNamePairs: similarNamePairsAll.slice(0, maxSimilarNamePairs),
    },
    truncated: {
      sameNormalizedName: Math.max(0, sameNormalizedNameAll.length - maxSameNameClusters),
      similarNamePairs: Math.max(0, similarNamePairsAll.length - maxSimilarNamePairs),
    },
  };
}

export function normalizeName(value: string) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-zñ\s]/g, " ")
    .replace(/\b(v|e|j|g|cedula|ci|c i)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nameSimilarity(first: string, second: string) {
  const left = normalizeName(first);
  const right = normalizeName(second);
  if (!left || !right) return 0;
  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function buildCluster(kind: DuplicateCluster["kind"], confidence: DuplicateCluster["confidence"], key: string, people: DuplicateAuditRow[], docs?: string[]): DuplicateCluster {
  return {
    kind,
    confidence,
    key,
    size: people.length,
    sources: [...new Set(people.map(sourceOf))],
    ...(docs && docs.length ? { docs } : {}),
    people: people.map(summarizePerson),
  };
}

function summarizePerson(row: DuplicateAuditRow): DuplicatePersonSummary {
  return {
    id: row.id,
    fullName: row.fullName,
    documentId: row.documentId,
    source: sourceOf(row),
    sourceUrl: row.sourceUrl,
    status: row.status,
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
  };
}

function sourceOf(row: DuplicateAuditRow) {
  const rawSource = row.raw?.source ?? row.raw?.provider;
  return typeof rawSource === "string" && rawSource.trim() ? rawSource.trim() : "unknown";
}

function nameSignature(value: string) {
  const tokens = normalizeName(value).split(" ").filter(Boolean);
  if (tokens.length < 2) return null;
  return `${tokens[0]}:${tokens[tokens.length - 1]}`;
}

function groupRows<T>(rows: T[], keyFor: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function countBy<T>(rows: T[], keyFor: (row: T) => string) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const key = keyFor(row);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function sortClusters(first: DuplicateCluster, second: DuplicateCluster) {
  return second.size - first.size || first.key.localeCompare(second.key);
}

function levenshteinDistance(first: string, second: string) {
  if (!first.length) return second.length;
  if (!second.length) return first.length;

  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex];
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current[secondIndex] = Math.min(
        previous[secondIndex]! + 1,
        current[secondIndex - 1]! + 1,
        previous[secondIndex - 1]! + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[second.length]!;
}
