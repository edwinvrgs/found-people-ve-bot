import { createHash } from "node:crypto";
import { extractDocumentId, sanitizeRelevantInfo } from "./sanitize.js";
import type { SearchCandidateInput } from "./search-provider.js";

const OCR_REPO = "ecrespo/OCR-data_Terremoto_Venezuela_24062026";
const CONSOLIDATED_CSV_PATH = "consolidado.csv";
const CONSOLIDATED_CSV_RAW_URL = `https://raw.githubusercontent.com/${OCR_REPO}/main/${CONSOLIDATED_CSV_PATH}`;
const CONSOLIDATED_CSV_BLOB_URL = `https://github.com/${OCR_REPO}/blob/main/${CONSOLIDATED_CSV_PATH}`;

export type ConsolidatedCsvRow = {
  rowNumber: number;
  cells: Record<string, string>;
};

function cleanCell(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeHeader(value: string) {
  return cleanCell(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function isLikelyBlank(value: string) {
  return !value.trim() || value.trim() === "—";
}

function parseCsvRecords(csv: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let current = "";
  let quoted = false;
  let physicalLine = 1;
  let recordStartLine = 1;

  const pushCell = () => {
    record.push(cleanCell(current));
    current = "";
  };

  const pushRecord = () => {
    pushCell();
    if (record.some((cell) => cell.trim())) records.push(record);
    record = [];
    recordStartLine = physicalLine + 1;
  };

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      pushCell();
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      pushRecord();
      physicalLine += 1;
      continue;
    }

    if (char === "\n") physicalLine += 1;
    current += char;
  }

  if (current || record.length > 0 || recordStartLine === physicalLine) pushRecord();

  return records;
}

export function parseConsolidatedCsv(csv: string): ConsolidatedCsvRow[] {
  const records = parseCsvRecords(csv.replace(/^\uFEFF/u, ""));
  if (records.length < 2) return [];

  const headers = records[0].map(normalizeHeader);
  const rows: ConsolidatedCsvRow[] = [];

  for (let index = 1; index < records.length; index += 1) {
    const values = records[index];
    const cells = Object.fromEntries(headers.map((header, cellIndex) => [header, values[cellIndex] ?? ""]));
    if (Object.values(cells).every(isLikelyBlank)) continue;
    rows.push({ rowNumber: index + 1, cells });
  }

  return rows;
}

function readCell(row: ConsolidatedCsvRow, keys: string[]) {
  for (const key of keys) {
    const value = row.cells[normalizeHeader(key)];
    if (value && !isLikelyBlank(value)) return value;
  }
  return "";
}

function normalizeFullName(name: string) {
  return name
    .replace(/\s+P\.\d+\s*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isClearlyBadName(name: string) {
  const cleaned = normalizeFullName(name);
  if (cleaned.length < 5 || cleaned.length > 120) return true;
  if (/https?:|www\.|@|#|\p{Extended_Pictographic}/iu.test(cleaned)) return true;
  if (/\d/.test(cleaned)) return true;
  return cleaned.split(/\s+/).filter(Boolean).length < 2;
}

function rowSourceUrl(rowNumber: number) {
  return `${CONSOLIDATED_CSV_BLOB_URL}#L${rowNumber}`;
}

function relevantInfoFromRow(row: ConsolidatedCsvRow) {
  const fields = [
    ["hospital", readCell(row, ["hospital / area", "hospital / área", "hospital"])],
    ["edad", readCell(row, ["edad"])],
    ["procedencia", readCell(row, ["procedencia / zona", "procedencia", "zona"])],
    ["servicio/lista", readCell(row, ["servicio / lista", "servicio/lista", "servicio", "lista"])],
    ["nota", readCell(row, ["nota"])],
  ];

  return fields
    .filter(([, value]) => value && !isLikelyBlank(value))
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}

export function consolidatedRowToCandidate(row: ConsolidatedCsvRow): SearchCandidateInput | null {
  const rawFullName = readCell(row, ["nombre"]);
  const fullName = normalizeFullName(rawFullName);
  if (!fullName || isClearlyBadName(fullName)) return null;

  const hospital = readCell(row, ["hospital / area", "hospital / área", "hospital"]);
  const documentValue = readCell(row, ["cedula", "cédula"]);
  const relevantInfo = relevantInfoFromRow(row);
  const documentId = extractDocumentId(documentValue);
  const stableRowKey = documentId ? `document:${documentId}` : `row:${row.rowNumber}:${hospital}:${fullName}`;

  return {
    fullName,
    relevantInfo: sanitizeRelevantInfo(`Lista heridos consolidada · ${relevantInfo}`),
    sourceUrl: rowSourceUrl(row.rowNumber),
    documentId,
    sourceHash: createHash("sha256").update(`github-ocr-consolidated:${OCR_REPO}:${CONSOLIDATED_CSV_PATH}:${stableRowKey}`).digest("hex"),
    raw: {
      provider: "github_ocr_consolidated_csv",
      source: "consolidated_injured_list",
      repo: OCR_REPO,
      path: CONSOLIDATED_CSV_PATH,
      row: row.rowNumber,
    },
  };
}

async function fetchConsolidatedCsv() {
  const response = await fetch(CONSOLIDATED_CSV_RAW_URL, { headers: { Accept: "text/csv,text/plain" } });
  if (!response.ok) throw new Error(`GitHub raw consolidated CSV failed with ${response.status}`);
  return response.text();
}

export async function searchConsolidatedCandidates(): Promise<{ candidates: SearchCandidateInput[]; errors: string[] }> {
  try {
    const rows = parseConsolidatedCsv(await fetchConsolidatedCsv());
    return {
      candidates: rows.flatMap((row) => {
        const candidate = consolidatedRowToCandidate(row);
        return candidate ? [candidate] : [];
      }),
      errors: [],
    };
  } catch (error) {
    return {
      candidates: [],
      errors: [`consolidated csv: ${error instanceof Error ? error.message : "unknown GitHub CSV error"}`],
    };
  }
}
