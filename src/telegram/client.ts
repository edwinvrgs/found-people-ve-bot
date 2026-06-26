import { env } from "../config/env.js";
import type { InlineButton } from "./types.js";

export function button(text: string, callbackData: string): InlineButton {
  return { text, callback_data: callbackData };
}

export async function sendMessage(chatId: number, text: string, inlineKeyboard?: InlineButton[][]) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  });
}

export async function editMessage(chatId: number, messageId: number, text: string, inlineKeyboard?: InlineButton[][]) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  });
}

export async function answerCallback(callbackQueryId: string, text?: string) {
  return telegram("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

async function telegram(method: string, body: Record<string, unknown>) {
  if (!env.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram actions");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Telegram ${method} failed with ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}
