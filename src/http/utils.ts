import type { FastifyReply, FastifyRequest } from "fastify";
import { rateLimit } from "../rate-limit.js";

export class RequestBodyTooLargeError extends Error {}
export class InvalidJsonError extends Error {}

export function queryParams(request: FastifyRequest) {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  return Object.fromEntries(url.searchParams);
}

export async function readJson(request: FastifyRequest) {
  const body = request.body;
  if (body == null) return {};
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString("utf8") || "{}");
    } catch {
      throw new InvalidJsonError("Invalid JSON");
    }
  }
  if (typeof body === "string") {
    try {
      return JSON.parse(body || "{}");
    } catch {
      throw new InvalidJsonError("Invalid JSON");
    }
  }
  return body;
}

export function applyRateLimit(reply: FastifyReply, key: string, limit: number, windowMs: number) {
  const limited = rateLimit(key, limit, windowMs);
  if (limited.allowed) return false;
  reply.header("retry-after", String(limited.retryAfterSeconds));
  json(reply, 429, { error: "Too many requests", retryAfterSeconds: limited.retryAfterSeconds });
  return true;
}

export function clientIp(request: FastifyRequest) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0].split(",")[0].trim();
  return request.ip ?? "unknown";
}

export function json(reply: FastifyReply, status: number, body: unknown) {
  return reply.type("application/json; charset=utf-8").status(status).send(body);
}

export function isJsonRequest(request: FastifyRequest) {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0].trim() === "application/json";
}
