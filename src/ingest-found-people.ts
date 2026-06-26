import { readFileSync } from "node:fs";
import { errorDetails, logger } from "./logger.js";
import { searchFoundPersonCandidates } from "./ingestion/search-provider.js";
import { countProviderErrorsBySource, DEFAULT_OUTPUT_DIR, runFoundPeopleIngest } from "./ingestion/run-ingestion.js";

type Args = {
  queryLimit: number;
  write: boolean;
  outputDir: string;
};

function loadDotenv(filePath: string) {
  try {
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      process.env[key] ??= rest.join("=").replace(/^[ '\"]|[ '\"]$/g, "");
    }
  } catch {
    // Optional in local/CI.
  }
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
  };

  return {
    queryLimit: Number(readValue("--query-limit", "0")),
    write: args.includes("--write"),
    outputDir: readValue("--output-dir", DEFAULT_OUTPUT_DIR),
  };
}

async function main() {
  loadDotenv(".env.local");
  const args = parseArgs();
  const { capture, shutdownAnalytics } = await import("./analytics.js");
  const db = args.write ? await import("./db.js") : null;

  try {
    const { outputPath, report } = await runFoundPeopleIngest({
      ...args,
      logger,
      searchCandidates: searchFoundPersonCandidates,
      upsertPeople: db?.upsertPeople,
    });

    const eventProperties = {
      ok: true,
      dryRun: !args.write,
      wroteToDatabase: args.write,
      queryLimit: args.queryLimit,
      durationMs: new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime(),
      candidates: report.counts.candidates,
      accepted: report.counts.accepted,
      skipped: report.counts.skipped,
      rejectedByProvider: report.counts.rejectedByProvider,
      providerErrors: report.counts.providerErrors,
      upserted: report.counts.upserted,
      sources: report.sources,
      providerErrorsBySource: countProviderErrorsBySource(report.providerErrors),
      sourceCount: Object.keys(report.sources).length,
      withDocumentId: Object.values(report.sources).reduce((total, source) => total + source.withDocumentId, 0),
    };
    capture("found_people_scrape_completed", process.env.POSTHOG_INGEST_DISTINCT_ID ?? "found_people_ingest", eventProperties);
    await shutdownAnalytics();

    console.log(JSON.stringify({ outputPath, counts: report.counts, sources: report.sources }, null, 2));
  } finally {
    await shutdownAnalytics();
    await db?.disconnectDatabase().catch(() => undefined);
  }
}

main().catch((error) => {
  logger.error({ event: "ingest_failed", ...errorDetails(error) }, "Found people ingest failed");
  process.exit(1);
});
