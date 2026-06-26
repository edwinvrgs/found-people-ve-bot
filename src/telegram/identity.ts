import { hashIdentifier } from "../analytics.js";
import type { TelegramUser } from "./types.js";

export function normalizeTelegramUsername(username: string | null | undefined) {
  const normalized = username?.trim().replace(/^@/, "");
  return normalized ? `@${normalized.toLowerCase()}` : null;
}

export function legacyTelegramUsernameDistinctId(username: string | null | undefined) {
  const normalizedUsername = normalizeTelegramUsername(username);
  return normalizedUsername ? `telegram:${normalizedUsername}` : null;
}

export function telegramDistinctId(chatId: number, user?: TelegramUser) {
  const userIdHash = hashIdentifier(user?.id);
  if (userIdHash) return `telegram_user:${userIdHash}`;

  const chatIdHash = hashIdentifier(chatId);
  if (chatIdHash) return `telegram_chat:${chatIdHash}`;

  return "telegram_unknown";
}

export function telegramAnalyticsProperties(chatId: number, user?: TelegramUser) {
  const normalizedUsername = normalizeTelegramUsername(user?.username);

  return {
    chatId: hashIdentifier(chatId),
    userId: hashIdentifier(user?.id),
    telegramHasUsername: Boolean(normalizedUsername),
    telegramUsername: normalizedUsername,
  };
}
