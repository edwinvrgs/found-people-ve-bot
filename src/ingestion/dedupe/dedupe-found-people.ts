import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "../../prisma.js";
import { buildDedupeMergePlan, type DedupeMergeOperation, type DedupeMergePlan, type DuplicateAuditRow } from "./found-people-duplicates.js";

const DEFAULT_OUTPUT_DIR = "artifacts/found-people-dedupe";

type Args = {
  outputDir: string;
  planPath?: string;
  apply: boolean;
  appliedBy: string;
  autoMergeExactNames: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string, fallback: string | undefined = undefined) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
  };

  return {
    outputDir: readValue("--output-dir", DEFAULT_OUTPUT_DIR)!,
    planPath: readValue("--plan"),
    apply: args.includes("--apply"),
    appliedBy: readValue("--applied-by", process.env.USER ?? "unknown")!,
    autoMergeExactNames: args.includes("--auto-merge-exact-names"),
  };
}

async function main() {
  const args = parseArgs();
  mkdirSync(args.outputDir, { recursive: true });

  const plan = args.planPath ? readPlan(args.planPath) : await generatePlan({ autoMergeExactNames: args.autoMergeExactNames });
  const planPath = args.planPath ?? writePlan(args.outputDir, plan);

  if (!args.apply) {
    console.log(JSON.stringify({
      mode: "dry_run",
      planPath,
      summary: plan.summary,
      strategy: plan.strategy,
      message: "No rows changed. Re-run with --apply --plan <path> only after reviewing the plan.",
    }, null, 2));
    return;
  }

  const result = await applyPlan(plan, args.appliedBy);
  console.log(JSON.stringify({ mode: "applied", planPath, ...result }, null, 2));
}

async function generatePlan(options: { autoMergeExactNames: boolean }) {
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

  return buildDedupeMergePlan(rows.map<DuplicateAuditRow>((row) => ({
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
  })), { autoMergeExactNormalizedNames: options.autoMergeExactNames });
}

function readPlan(planPath: string): DedupeMergePlan {
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as DedupeMergePlan;
  if (plan.mode !== "dry_run_plan" || !Array.isArray(plan.operations)) {
    throw new Error(`Invalid dedupe merge plan: ${planPath}`);
  }
  return plan;
}

function writePlan(outputDir: string, plan: DedupeMergePlan) {
  const outputPath = path.join(outputDir, `dedupe-plan-${plan.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outputPath, JSON.stringify(plan, null, 2));
  return outputPath;
}

async function applyPlan(plan: DedupeMergePlan, appliedBy: string) {
  return prisma.$transaction(async (tx) => {
    let canonicalRowsUpdated = 0;
    let duplicateRowsRemoved = 0;
    let auditRowsInserted = 0;

    for (const operation of plan.operations) {
      await applyOperation(tx, operation, appliedBy);
      canonicalRowsUpdated += 1;
      duplicateRowsRemoved += operation.duplicateIds.length;
      auditRowsInserted += operation.duplicateIds.length;
    }

    return {
      canonicalRowsUpdated,
      duplicateRowsRemoved,
      auditRowsInserted,
    };
  }, {
    maxWait: 10_000,
    timeout: 300_000,
  });
}

async function applyOperation(tx: Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">, operation: DedupeMergeOperation, appliedBy: string) {
  const [beforeCanonical] = await tx.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM found_people WHERE id = ${operation.canonicalId}::uuid FOR UPDATE`;
  if (!beforeCanonical) throw new Error(`Canonical row not found: ${operation.canonicalId}`);

  await tx.$executeRaw`
    UPDATE found_people SET
      full_name = ${operation.merged.fullName},
      relevant_info = ${operation.merged.relevantInfo},
      document_id = ${operation.merged.documentId},
      source_url = ${operation.merged.sourceUrl},
      status = ${operation.merged.status},
      raw = ${JSON.stringify(operation.merged.raw)}::jsonb,
      updated_at = now()
    WHERE id = ${operation.canonicalId}::uuid`;

  for (const duplicateId of operation.duplicateIds) {
    const [beforeDuplicate] = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM found_people WHERE id = ${duplicateId}::uuid FOR UPDATE`;
    if (!beforeDuplicate) throw new Error(`Duplicate row not found: ${duplicateId}`);

    const duplicateMergeMetadata = {
      mergedIntoId: operation.canonicalId,
      mergeReason: operation.reason,
      mergeKey: operation.key,
      mergedAt: new Date().toISOString(),
    };

    await tx.$executeRaw`
      UPDATE found_people SET
        status = 'removed',
        raw = raw || ${JSON.stringify(duplicateMergeMetadata)}::jsonb,
        updated_at = now()
      WHERE id = ${duplicateId}::uuid`;

    await tx.$executeRaw`
      INSERT INTO found_people_merge_audit (
        canonical_id,
        duplicate_id,
        reason,
        confidence,
        before_canonical,
        before_duplicate,
        planned_canonical,
        applied_by
      ) VALUES (
        ${operation.canonicalId}::uuid,
        ${duplicateId}::uuid,
        ${operation.reason},
        ${operation.confidence},
        ${JSON.stringify(beforeCanonical)}::jsonb,
        ${JSON.stringify(beforeDuplicate)}::jsonb,
        ${JSON.stringify(operation.merged)}::jsonb,
        ${appliedBy}
      )`;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
