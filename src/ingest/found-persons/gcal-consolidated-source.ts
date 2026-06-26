import { createHash } from "node:crypto";
import { extractDocumentId, sanitizeRelevantInfo } from "./sanitize.js";
import type { SearchCandidateInput } from "./search-provider.js";

const OCR_REPO = "ecrespo/OCR-data_Terremoto_Venezuela_24062026";
const CONSOLIDATED_MARKDOWN_PATH = "20260626/Lista_GCal_Consolidada/Lista_heridos_consolidada.md";
const CONSOLIDATED_MARKDOWN_RAW_URL = `https://raw.githubusercontent.com/${OCR_REPO}/main/${CONSOLIDATED_MARKDOWN_PATH}`;
const CONSOLIDATED_MARKDOWN_BLOB_URL = `https://github.com/${OCR_REPO}/blob/main/${CONSOLIDATED_MARKDOWN_PATH}`;
const DEFAULT_SPREADSHEET_ID = "1MkS1pz6Aox-K6rcGQOPiVq7widKnXCDd";
const DEFAULT_SPREADSHEET_GID = "610275581";
const DEFAULT_SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${DEFAULT_SPREADSHEET_ID}/edit?gid=${DEFAULT_SPREADSHEET_GID}#gid=${DEFAULT_SPREADSHEET_GID}`;

export type ConsolidatedCsvRow = {
  rowNumber: number;
  cells: Record<string, string>;
};

export type ConsolidatedSheetInfo = {
  spreadsheetId: string;
  gid: string;
  url: string;
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

function isClearlyBadName(name: string) {
  const cleaned = name.trim();
  if (cleaned.length < 5 || cleaned.length > 120) return true;
  if (/https?:|www\.|@|#|\p{Extended_Pictographic}/iu.test(cleaned)) return true;
  if (/\d/.test(cleaned)) return true;
  return cleaned.split(/\s+/).filter(Boolean).length < 2;
}

function extractFirstHttpUrl(value: string) {
  return value.match(/https?:\/\/\S+/iu)?.[0]?.replace(/[),.;]+$/u, "") ?? null;
}

function sheetRowUrl(sheet: ConsolidatedSheetInfo, rowNumber: number) {
  return `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit?gid=${sheet.gid}#gid=${sheet.gid}&range=A${rowNumber}:I${rowNumber}`;
}

function relevantInfoFromRow(row: ConsolidatedCsvRow) {
  const fields = [
    ["hospital", readCell(row, ["hospital"])],
    ["edad", readCell(row, ["edad"])],
    ["procedencia", readCell(row, ["procedencia"])],
    ["servicio/lista", readCell(row, ["servicio/lista", "servicio", "lista"])],
    ["estado", readCell(row, ["estado"])],
    ["nota", readCell(row, ["nota"])],
  ];

  return fields
    .filter(([, value]) => value && !isLikelyBlank(value))
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}

export function consolidatedRowToCandidate(row: ConsolidatedCsvRow, sheet: ConsolidatedSheetInfo): SearchCandidateInput | null {
  const fullName = readCell(row, ["nombre"]);
  if (!fullName || isClearlyBadName(fullName)) return null;

  const hospital = readCell(row, ["hospital"]);
  const documentValue = readCell(row, ["cedula", "cédula"]);
  const sourceValue = readCell(row, ["fuente"]);
  const sourceUrl = extractFirstHttpUrl(sourceValue) ?? sheetRowUrl(sheet, row.rowNumber);
  const relevantInfo = relevantInfoFromRow(row);
  const documentId = extractDocumentId(documentValue);
  const stableRowKey = documentId ? `document:${documentId}` : `row:${row.rowNumber}:${hospital}:${fullName}`;

  return {
    fullName: fullName.replace(/\s+/g, " ").trim(),
    relevantInfo: sanitizeRelevantInfo(`Lista heridos consolidada · ${relevantInfo}`),
    sourceUrl,
    documentId,
    sourceHash: createHash("sha256").update(`github-ocr-gcal-consolidated:${sheet.spreadsheetId}:${sheet.gid}:${stableRowKey}`).digest("hex"),
    raw: {
      provider: "github_ocr_gcal_consolidated",
      source: "gcal_consolidated_injured_list",
      repo: OCR_REPO,
      markdownPath: CONSOLIDATED_MARKDOWN_PATH,
      spreadsheetId: sheet.spreadsheetId,
      gid: sheet.gid,
      row: row.rowNumber,
    },
  };
}

function spreadsheetInfoFromMarkdown(markdown: string): ConsolidatedSheetInfo {
  const match = markdown.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/\s]+)\/[^\s)]+gid=(\d+)/iu);
  if (!match) {
    return { spreadsheetId: DEFAULT_SPREADSHEET_ID, gid: DEFAULT_SPREADSHEET_GID, url: DEFAULT_SPREADSHEET_URL };
  }

  return {
    spreadsheetId: match[1],
    gid: match[2],
    url: `https://docs.google.com/spreadsheets/d/${match[1]}/edit?gid=${match[2]}#gid=${match[2]}`,
  };
}

async function fetchMarkdownSheetInfo(errors: string[]) {
  try {
    const response = await fetch(CONSOLIDATED_MARKDOWN_RAW_URL, { headers: { Accept: "text/plain" } });
    if (!response.ok) {
      errors.push(`gcal_consolidated markdown: GitHub raw failed with ${response.status}`);
      return { spreadsheetId: DEFAULT_SPREADSHEET_ID, gid: DEFAULT_SPREADSHEET_GID, url: DEFAULT_SPREADSHEET_URL };
    }
    return spreadsheetInfoFromMarkdown(await response.text());
  } catch (error) {
    errors.push(`gcal_consolidated markdown: ${error instanceof Error ? error.message : "unknown GitHub markdown error"}`);
    return { spreadsheetId: DEFAULT_SPREADSHEET_ID, gid: DEFAULT_SPREADSHEET_GID, url: DEFAULT_SPREADSHEET_URL };
  }
}

async function fetchSheetCsv(sheet: ConsolidatedSheetInfo) {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/export?format=csv&gid=${sheet.gid}`;
  const response = await fetch(csvUrl, { headers: { Accept: "text/csv,text/plain" } });
  if (!response.ok) throw new Error(`Google Sheets CSV export failed with ${response.status}`);
  return response.text();
}

export async function searchGcalConsolidatedCandidates(): Promise<{ candidates: SearchCandidateInput[]; errors: string[] }> {
  const errors: string[] = [];
  const sheet = await fetchMarkdownSheetInfo(errors);

  try {
    const rows = parseConsolidatedCsv(await fetchSheetCsv(sheet));
    return {
      candidates: rows.flatMap((row) => {
        const candidate = consolidatedRowToCandidate(row, sheet);
        return candidate ? [candidate] : [];
      }),
      errors,
    };
  } catch (error) {
    errors.push(`gcal_consolidated csv: ${error instanceof Error ? error.message : "unknown Google Sheets CSV error"}`);
    errors.push(`gcal_consolidated fallback: ${CONSOLIDATED_MARKDOWN_BLOB_URL}`);
    return { candidates: [], errors };
  }
}
