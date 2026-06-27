export const env = {
  port: Number(process.env.PORT ?? 3000),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  ingestSecret: process.env.INGEST_SECRET,
  externalApiSecret: process.env.EXTERNAL_API_SECRET,
  foundPeopleApiBaseUrl: process.env.FOUND_PEOPLE_API_BASE_URL?.replace(/\/$/, ""),
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID ? Number(process.env.TELEGRAM_ADMIN_CHAT_ID) : null,
};

export function publicBaseUrl() {
  return (env.publicBaseUrl ?? `http://localhost:${env.port}`).replace(/\/$/, "");
}
