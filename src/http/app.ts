import fastify from "fastify";
import { analyticsEnabled, captureSystem, hashIdentifier } from "../analytics.js";
import { errorDetails, logger } from "../logger.js";
import { createExternalReport, ingestPeople, listExternalFoundPeople, listPublicPeople, removePeopleBySourceUrl } from "../services/found-people-service.js";
import { buildFoundPeopleSearchCriteria, searchCriteriaKind } from "../services/found-people-search.js";
import { incrementMetric } from "../services/metrics-service.js";
import { publicBaseUrl } from "../config/env.js";
import { formatAdminPerson, handleTelegramUpdate, notifyAdmin, TelegramUpdateSchema } from "../telegram/bot.js";
import { MAX_JSON_BODY_BYTES, PUBLIC_API_LIMIT } from "./constants.js";
import { DeletePersonSchema, ExternalListQuerySchema, ExternalReportSchema, IngestSchema, lengthBucket, PeopleQuerySchema } from "./schemas.js";
import { guardAdminRequest, guardExternalReportRequest, guardTelegramWebhookRequest } from "./security.js";
import { applyRateLimit, clientIp, InvalidJsonError, isJsonRequest, json, queryParams, readJson, RequestBodyTooLargeError } from "./utils.js";

export function createApp() {
  const server = fastify({
    bodyLimit: MAX_JSON_BODY_BYTES,
    exposeHeadRoutes: false,
    logger: false,
    requestTimeout: 15_000,
    trustProxy: true,
  });

  server.server.headersTimeout = 16_000;
  server.server.keepAliveTimeout = 5_000;

  server.addHook("onRequest", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
  });

  server.setErrorHandler((error, _request, reply) => {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : null;
    if (error instanceof RequestBodyTooLargeError || code === "FST_ERR_CTP_BODY_TOO_LARGE") return json(reply, 413, { error: "Request body too large" });
    if (error instanceof InvalidJsonError || code === "FST_ERR_CTP_INVALID_JSON_BODY") return json(reply, 400, { error: "Invalid JSON" });
    logger.error({ event: "request_failed", ...errorDetails(error) }, "Unhandled request error");
    return json(reply, 500, { error: "Internal error" });
  });

  server.get("/health", async (_request, reply) => {
    return json(reply, 200, { ok: true, analytics: analyticsEnabled() ? "configured" : "disabled" });
  });

  server.get("/api/people", async (request, reply) => {
    const clientKey = clientIp(request);
    const limited = applyRateLimit(reply, `public:${clientKey}`, PUBLIC_API_LIMIT.count, PUBLIC_API_LIMIT.windowMs);
    if (limited) return;

    const parsed = PeopleQuerySchema.safeParse(queryParams(request));
    if (!parsed.success) return json(reply, 400, { error: "Invalid pagination" });
    return json(reply, 200, await listPublicPeople(parsed.data.page, parsed.data.pageSize));
  });

  server.get("/api/v1/found-people", async (request, reply) => {
    const clientKey = clientIp(request);
    const limited = applyRateLimit(reply, `external-list:${clientKey}`, PUBLIC_API_LIMIT.count, PUBLIC_API_LIMIT.windowMs);
    if (limited) return;

    const parsed = ExternalListQuerySchema.safeParse(queryParams(request));
    if (!parsed.success) return json(reply, 400, { error: "Invalid pagination" });

    const { page, pageSize, q, name, documentId } = parsed.data;
    const criteria = buildFoundPeopleSearchCriteria({ q, name, documentId });
    const result = await listExternalFoundPeople({ page, pageSize, q, name, documentId });
    await incrementMetric("external_api_list");
    const searchValue = documentId ?? name ?? q;
    captureSystem("external_api_list_requested", {
      page,
      pageSize,
      total: result.total,
      clientId: hashIdentifier(clientKey),
      queryType: searchCriteriaKind(criteria),
      ...(searchValue ? { queryLengthBucket: lengthBucket(searchValue.length) } : {}),
    });
    return json(reply, 200, {
      data: result.items,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  });

  server.post("/api/v1/found-people/reports", { onRequest: guardExternalReportRequest }, async (request, reply) => {
    const clientKey = clientIp(request);
    if (!isJsonRequest(request)) return json(reply, 415, { error: "Content-Type must be application/json" });

    const parsed = ExternalReportSchema.safeParse(await readJson(request));
    if (!parsed.success) return json(reply, 400, { error: "Invalid report payload" });

    const report = await createExternalReport(parsed.data, {
      idempotencyKey: typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined,
      publicBaseUrl: publicBaseUrl(),
    });
    await incrementMetric("external_api_report");
    captureSystem("external_report_created", {
      hasSourceUrl: Boolean(parsed.data.sourceUrl),
      hasNotes: Boolean(parsed.data.notes),
      hasReporter: Boolean(parsed.data.reporter),
      hasReporterService: Boolean(parsed.data.reporter?.service),
      idempotencyKeyPresent: typeof request.headers["idempotency-key"] === "string",
      clientId: hashIdentifier(clientKey),
    });
    await notifyAdmin(`🆕 <b>Reporte externo insertado</b>\n\n${formatAdminPerson(report)}`);
    return json(reply, 201, { data: report });
  });

  server.post("/api/ingest", { onRequest: guardAdminRequest }, async (request, reply) => {
    const parsed = IngestSchema.safeParse(await readJson(request));
    if (!parsed.success) return json(reply, 400, { error: "Invalid ingest payload" });

    const rows = await ingestPeople(parsed.data.people);
    return json(reply, 200, { upserted: rows.length, people: rows });
  });

  server.delete("/api/people", { onRequest: guardAdminRequest }, async (request, reply) => {
    const parsed = DeletePersonSchema.safeParse(await readJson(request));
    if (!parsed.success) return json(reply, 400, { error: "Invalid delete payload" });

    const rows = await removePeopleBySourceUrl(parsed.data.sourceUrl);
    return json(reply, 200, { deleted: rows.length, people: rows });
  });

  server.post("/telegram/webhook", { onRequest: guardTelegramWebhookRequest }, async (request, reply) => {
    const update = TelegramUpdateSchema.parse(await readJson(request));
    void handleTelegramUpdate(update).catch((error) => {
      logger.error({ event: "telegram_update_failed", ...errorDetails(error) }, "Telegram update failed");
    });
    return json(reply, 200, { ok: true });
  });

  server.setNotFoundHandler((_request, reply) => json(reply, 404, { error: "Not found" }));

  return server;
}
