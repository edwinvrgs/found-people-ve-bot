import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
  base: {
    service: "found-people-ve-bot",
    environment: process.env.NODE_ENV ?? "development",
  },
  redact: {
    paths: [
      "authorization",
      "headers.authorization",
      "headers.cookie",
      "headers['x-telegram-bot-api-secret-token']",
      "telegramToken",
      "telegramWebhookSecret",
      "ingestSecret",
      "externalApiSecret",
      "DATABASE_URL",
    ],
    censor: "[redacted]",
  },
});

export function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}
