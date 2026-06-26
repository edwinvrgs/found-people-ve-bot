import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../../prisma.js";
import { buildDuplicateAuditReport, type DuplicateAuditRow } from "./found-people-duplicates.js";

const DEFAULT_OUTPUT_DIR = "artifacts/found-people-duplicates";

type Args = {
  outputDir: string;
  maxSameNameClusters?: number;
  maxSimilarNamePairs?: number;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string, fallback: string | undefined = undefined) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
  };
  const readNumber = (name: string) => {
    const value = readValue(name);
    return value ? Number(value) : undefined;
  };

  return {
    outputDir: readValue("--output-dir", DEFAULT_OUTPUT_DIR)!,
    maxSameNameClusters: readNumber("--max-same-name-clusters"),
    maxSimilarNamePairs: readNumber("--max-similar-name-pairs"),
  };
}

async function main() {
  const args = parseArgs();
  mkdirSync(args.outputDir, { recursive: true });

  const rows = await prisma.$queryRaw<Array<{
    id: string;
    full_name: string;
    relevant_info: string | null;
    document_id: string | null;
    source_url: string;
    source_hash: string | null;
    status: string;
    raw: Record<string, unknown> | null;
    created_at: Date;
    updated_at: Date;
  }>>`
    SELECT
      id::text,
      full_name,
      relevant_info,
      document_id,
      source_url,
      source_hash,
      status,
      raw,
      created_at,
      updated_at
    FROM found_people
    WHERE status IN ('verified', 'citizen_report')`;

  const report = buildDuplicateAuditReport(rows.map<DuplicateAuditRow>((row) => ({
    id: row.id,
    fullName: row.full_name,
    relevantInfo: row.relevant_info,
    documentId: row.document_id,
    sourceUrl: row.source_url,
    sourceHash: row.source_hash,
    status: row.status,
    raw: row.raw,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })), {
    maxSameNameClusters: args.maxSameNameClusters,
    maxSimilarNamePairs: args.maxSimilarNamePairs,
  });

  const outputPath = path.join(args.outputDir, `duplicates-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    outputPath,
    totalVisibleRows: report.totalVisibleRows,
    sourceCounts: report.sourceCounts,
    summary: report.summary,
    truncated: report.truncated,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
