import { env } from "./config/env.js";
import { createApp } from "./http/app.js";
import { logger } from "./logger.js";
import { sweepRateLimitBuckets } from "./rate-limit.js";
import { shutdownAnalytics } from "./analytics.js";

setInterval(sweepRateLimitBuckets, 60_000).unref();

const server = createApp();
await server.listen({ port: env.port, host: "0.0.0.0" });
logger.info({ event: "server_started", port: env.port }, `found-people-ve-bot listening on :${env.port}`);

process.once("SIGTERM", () => {
  void shutdownAnalytics().finally(() => process.exit(0));
});

process.once("SIGINT", () => {
  void shutdownAnalytics().finally(() => process.exit(0));
});
