import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { ADMIN_API_LIMIT, EXTERNAL_REPORT_API_LIMIT } from "./constants.js";
import { applyRateLimit, clientIp, json } from "./utils.js";

function validateTelegramSecret(header: string | string[] | undefined) {
  if (!env.telegramWebhookSecret) return "Telegram webhook secret is not configured";
  return header === env.telegramWebhookSecret ? null : "Invalid Telegram webhook secret";
}

function validateBearer(header: string | undefined, expected: string | undefined) {
  if (!expected) return { status: 503, message: "INGEST_SECRET is not configured" };
  if (header !== `Bearer ${expected}`) return { status: 401, message: "Unauthorized" };
  return null;
}

function validateBearerSecure(header: string | undefined, expected: string | undefined, secretName: string) {
  if (!expected) return { status: 503, message: `${secretName} is not configured` };
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return { status: 401, message: "Unauthorized" };
  return timingSafeEqualString(header.slice(prefix.length), expected) ? null : { status: 401, message: "Unauthorized" };
}

function timingSafeEqualString(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function guardAdminRequest(request: FastifyRequest, reply: FastifyReply) {
  const clientKey = clientIp(request);
  const limited = applyRateLimit(reply, `admin:${clientKey}`, ADMIN_API_LIMIT.count, ADMIN_API_LIMIT.windowMs);
  if (limited) return;

  const authError = validateBearer(request.headers.authorization, env.ingestSecret);
  if (authError) void json(reply, authError.status, { error: authError.message });
}

export function guardExternalReportRequest(request: FastifyRequest, reply: FastifyReply) {
  const clientKey = clientIp(request);
  const limited = applyRateLimit(reply, `external-report:${clientKey}`, EXTERNAL_REPORT_API_LIMIT.count, EXTERNAL_REPORT_API_LIMIT.windowMs);
  if (limited) return;

  const authError = validateBearerSecure(request.headers.authorization, env.externalApiSecret, "EXTERNAL_API_SECRET");
  if (authError) {
    void json(reply, authError.status, { error: authError.message });
    return;
  }

  const authLimited = applyRateLimit(reply, `external-report-auth:${clientKey}:${hashForRateLimit(request.headers.authorization ?? "")}`, EXTERNAL_REPORT_API_LIMIT.count, EXTERNAL_REPORT_API_LIMIT.windowMs);
  if (authLimited) return;
}

export function guardTelegramWebhookRequest(request: FastifyRequest, reply: FastifyReply) {
  const secretError = validateTelegramSecret(request.headers["x-telegram-bot-api-secret-token"]);
  if (secretError) void json(reply, 401, { error: secretError });
}


function hashForRateLimit(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
