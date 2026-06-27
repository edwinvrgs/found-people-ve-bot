import { alias, capture, identify } from "../analytics.js";
import type { FoundPerson } from "../db.js";
import { env } from "../config/env.js";
import { logger, errorDetails } from "../logger.js";
import { TELEGRAM_CHAT_LIMIT } from "../http/constants.js";
import { lengthBucket, TelegramSearchQuerySchema } from "../http/schemas.js";
import { rateLimit } from "../rate-limit.js";
import { getPersonDetails, getStats, listPublicPeople, removePersonById, removePeopleBySourceUrl, searchPublicPeople } from "../services/found-people-service.js";
import { incrementMetric } from "../services/metrics-service.js";
import { captureSearchMatched, documentSearchLabel } from "../search-analytics.js";
import { upsertTelegramChat, type TelegramChatInput } from "../repositories/telegram-chat-repository.js";
import { answerCallback, button, editMessage, sendMessage } from "./client.js";
import { legacyTelegramUsernameDistinctId, telegramAnalyticsProperties, telegramDistinctId } from "./identity.js";
import type { InlineButton, TelegramUpdate, TelegramUser } from "./types.js";
import { z } from "zod";

export const TelegramUpdateSchema = z.object({
  message: z.object({
    message_id: z.number(),
    chat: z.object({ id: z.number(), type: z.string().max(32).optional() }),
    from: z.object({
      id: z.number(),
      username: z.string().max(64).optional(),
      first_name: z.string().max(128).optional(),
      last_name: z.string().max(128).optional(),
    }).optional(),
    text: z.string().max(1500).optional(),
  }).optional(),
  callback_query: z.object({
    id: z.string().max(120),
    from: z.object({
      id: z.number(),
      username: z.string().max(64).optional(),
      first_name: z.string().max(128).optional(),
      last_name: z.string().max(128).optional(),
    }).optional(),
    data: z.string().max(64).optional(),
    message: z.object({
      chat: z.object({ id: z.number(), type: z.string().max(32).optional() }),
      message_id: z.number(),
    }).optional(),
  }).optional(),
});

type PendingChatAction =
  | { kind: "search"; expiresAt: number }
  | { kind: "feedback"; expiresAt: number };

const pendingChatActions = new Map<number, PendingChatAction>();
const shortPersonIds = new Map<string, { id: string; expiresAt: number }>();
const PENDING_ACTION_TTL_MS = 15 * 60_000;
const identifiedTelegramUsers = new Set<string>();

function telegramEvent(event: string, chatId: number) {
  return event;
}

function identifyTelegramActor(chatId: number, user?: TelegramUser) {
  const distinctId = telegramDistinctId(chatId, user);
  if (identifiedTelegramUsers.has(distinctId)) return;

  identify(distinctId, telegramAnalyticsProperties(chatId, user));
  identifiedTelegramUsers.add(distinctId);

  const legacyDistinctId = legacyTelegramUsernameDistinctId(user?.username);
  if (legacyDistinctId && legacyDistinctId !== distinctId) alias(legacyDistinctId, distinctId);
}

function captureTelegramCommand(message: NonNullable<TelegramUpdate["message"]>, command: string, properties: Record<string, string | number | boolean | null | undefined> = {}) {
  capture("telegram_command", telegramDistinctId(message.chat.id, message.from), {
    command,
    ...telegramAnalyticsProperties(message.chat.id, message.from),
    ...properties,
  });
}

function commandName(text: string) {
  const match = text.match(/^\/([a-zA-Z_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/);
  return match?.[1]?.toLowerCase() ?? null;
}

function isCommand(text: string, command: string) {
  return new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?(?:\\s|$)`, "i").test(text);
}

function commandPayload(text: string) {
  return text.replace(/^\/[a-zA-Z_]+(?:@[A-Za-z0-9_]+)?\s*/i, "").trim();
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.callback_query) return handleCallback(update.callback_query);

  const message = update.message;
  if (message) rememberTelegramChat(message.chat, message.from);
  if (!message?.text) return;

  const limited = rateLimit(`chat:${message.chat.id}`, TELEGRAM_CHAT_LIMIT.count, TELEGRAM_CHAT_LIMIT.windowMs);
  if (!limited.allowed) {
    capture(telegramEvent("rate_limited", message.chat.id), telegramDistinctId(message.chat.id, message.from), { surface: "telegram_message", retryAfterSeconds: limited.retryAfterSeconds });
    return sendMessage(message.chat.id, `Demasiadas consultas seguidas. Intenta de nuevo en ${limited.retryAfterSeconds}s.`);
  }

  const text = message.text.trim();
  identifyTelegramActor(message.chat.id, message.from);
  capture(telegramEvent("message_received", message.chat.id), telegramDistinctId(message.chat.id, message.from), {
    chatType: "direct_or_group",
    isCommand: text.startsWith("/"),
    command: text.startsWith("/") ? commandName(text) : null,
    textLengthBucket: lengthBucket(text.length),
  });
  const pending = getPendingChatAction(message.chat.id);
  if (pending && !text.startsWith("/")) return handlePendingChatAction(message, text, pending);

  if (isCommand(text, "start") || isCommand(text, "ayuda")) {
    pendingChatActions.delete(message.chat.id);
    captureTelegramCommand(message, isCommand(text, "ayuda") ? "ayuda" : "start");
    return sendMenu(message.chat.id);
  }
  if (isCommand(text, "cancelar")) {
    captureTelegramCommand(message, "cancelar");
    return cancelPendingAction(message.chat.id);
  }
  if (isCommand(text, "fuentes")) {
    pendingChatActions.delete(message.chat.id);
    captureTelegramCommand(message, "fuentes");
    return handleSourceCommand(message, text);
  }

  if (text.startsWith("/admin")) {
    return handleAdminCommand(message, text);
  }

  if (isCommand(text, "lista")) {
    pendingChatActions.delete(message.chat.id);
    await incrementMetric("telegram_list");
    captureTelegramCommand(message, "lista");
    return sendPeoplePage(message.chat.id, 1, undefined, message.from);
  }

  if (isCommand(text, "sugerencia")) {
    pendingChatActions.delete(message.chat.id);
    captureTelegramCommand(message, "sugerencia");
    return handleFeedbackCommand(message, text);
  }


  if (isCommand(text, "buscar")) {
    pendingChatActions.delete(message.chat.id);
    const query = commandPayload(text);
    captureTelegramCommand(message, "buscar", { hasQuery: Boolean(query) });
    if (!query) return askForSearch(message.chat.id);
    return sendSearchResults(message.chat.id, query, message);
  }

  if (text.startsWith("/")) return sendMessage(message.chat.id, "No reconozco ese comando. Usa /ayuda para ver las opciones.");

  return sendSearchResults(message.chat.id, text, message);
}

export function telegramChatInput(chat: { id: number; type?: string }, user?: TelegramUser): TelegramChatInput {
  const analyticsProperties = telegramAnalyticsProperties(chat.id, user);
  return {
    chatId: chat.id,
    username: typeof analyticsProperties.telegramUsername === "string" ? analyticsProperties.telegramUsername : null,
    chatType: chat.type ?? "unknown",
  };
}

function rememberTelegramChat(chat: { id: number; type?: string }, user?: TelegramUser) {
  if (process.env.TELEGRAM_CHAT_REGISTRY_DISABLED === "true") return;
  void upsertTelegramChat(telegramChatInput(chat, user)).catch((error) => {
    logger.warn({ event: "telegram_chat_upsert_failed", ...errorDetails(error) });
  });
}

function getPendingChatAction(chatId: number) {
  const pending = pendingChatActions.get(chatId);
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) {
    pendingChatActions.delete(chatId);
    return null;
  }
  return pending;
}

function setPendingChatAction(chatId: number, action: Record<string, unknown> & { kind: PendingChatAction["kind"] }) {
  pendingChatActions.set(chatId, { ...action, expiresAt: Date.now() + PENDING_ACTION_TTL_MS } as PendingChatAction);
}

function cancelPendingAction(chatId: number) {
  pendingChatActions.delete(chatId);
  return sendMessage(chatId, "Listo, cancelé la operación pendiente.");
}

async function handlePendingChatAction(message: NonNullable<TelegramUpdate["message"]>, text: string, pending: PendingChatAction) {
  if (text.toLowerCase() === "cancelar" || isCommand(text, "cancelar")) return cancelPendingAction(message.chat.id);

  if (pending.kind === "search") {
    pendingChatActions.delete(message.chat.id);
    return sendSearchResults(message.chat.id, text.trim(), message);
  }

  if (pending.kind === "feedback") {
    pendingChatActions.delete(message.chat.id);
    return submitFeedback(message, text.trim());
  }
  return sendMessage(message.chat.id, "No hay una operación pendiente para ese mensaje. Usa /ayuda para ver las opciones.");
}

function rememberPersonId(id: string) {
  const shortId = id.replace(/-/g, "").slice(0, 12);
  shortPersonIds.set(shortId, { id, expiresAt: Date.now() + 60 * 60_000 });
  return shortId;
}

function resolvePersonId(value: string) {
  const cleaned = value.trim();
  const cached = shortPersonIds.get(cleaned);
  if (cached && cached.expiresAt >= Date.now()) return cached.id;
  return cleaned;
}

async function handleAdminCommand(message: NonNullable<TelegramUpdate["message"]>, text: string) {
  if (!isAdminChat(message.chat.id)) {
    captureTelegramCommand(message, "admin_unauthorized", { attemptedCommand: commandName(text) });
    return sendMessage(message.chat.id, "No autorizado.");
  }
  await incrementMetric("telegram_admin_command");
  captureTelegramCommand(message, commandName(text) ?? "admin");

  if (text === "/admin" || text === "/admin_help") return sendMessage(message.chat.id, adminHelpText());

  if (text === "/admin_stats") {
    const stats = await getStats();
    return sendMessage(message.chat.id, `📊 <b>Stats</b>

Total in database: ${stats.total}

Metrics:
${formatMetrics(stats.metrics)}`);
  }


  if (text.startsWith("/admin_delete")) {
    const target = text.replace(/^\/admin_delete\s*/i, "").trim();
    if (!target) return sendMessage(message.chat.id, "Usage: /admin_delete id-or-url");

    const rows = isHttpUrl(target) ? await removePeopleBySourceUrl(target) : await removePersonById(resolvePersonId(target));
    if (rows.length === 0) return sendMessage(message.chat.id, "No matching record found to delete.");
    await incrementMetric("admin_delete");
    return sendMessage(message.chat.id, `🗑️ Record permanently deleted:

${formatAdminPerson(rows[0])}`);
  }

  return sendMessage(message.chat.id, adminHelpText());
}

function isAdminChat(chatId: number) {
  return env.adminChatId !== null && chatId === env.adminChatId;
}

function adminHelpText() {
  return "🔐 <b>Admin commands</b>\n\n/admin_stats — metrics and totals\n/admin_delete id-or-url — permanently delete\n/admin_help — show this help";
}

async function handleCallback(callback: NonNullable<TelegramUpdate["callback_query"]>) {
  if (!callback.message) return answerCallback(callback.id);

  const chatId = callback.message.chat.id;
  rememberTelegramChat(callback.message.chat, callback.from);
  const limited = rateLimit(`chat:${chatId}`, TELEGRAM_CHAT_LIMIT.count, TELEGRAM_CHAT_LIMIT.windowMs);
  if (!limited.allowed) {
    capture(telegramEvent("rate_limited", chatId), telegramDistinctId(chatId, callback.from), { surface: "telegram_callback", retryAfterSeconds: limited.retryAfterSeconds });
    return answerCallback(callback.id, `Intenta de nuevo en ${limited.retryAfterSeconds}s.`);
  }

  identifyTelegramActor(chatId, callback.from);

  const messageId = callback.message.message_id;
  const data = callback.data ?? "";

  if (data === "menu") {
    await answerCallback(callback.id);
    return editMessage(chatId, messageId, menuText(), menuButtons());
  }

  if (data === "search") {
    await answerCallback(callback.id);
    setPendingChatAction(chatId, { kind: "search" });
    return editMessage(chatId, messageId, "Escribe el nombre, apellido o cédula que quieres buscar.\n\nEjemplos: Maria Perez · V12345678", [[button("📋 Ver lista", "list:1")]]);
  }


  const listMatch = data.match(/^list:(\d+)$/);
  if (listMatch) {
    await answerCallback(callback.id);
    return sendPeoplePage(chatId, Number(listMatch[1]), messageId, callback.from);
  }

  return answerCallback(callback.id);
}

async function sendMenu(chatId: number) {
  return sendMessage(chatId, menuText(), menuButtons());
}

function menuText() {
  return `<b>Personas Encontradas 🇻🇪</b>

Este bot ayuda a consultar personas encontradas tras el terremoto en Venezuela.

Reúne información de fuentes públicas y transcripciones de listas de atención médica para apoyar a familiares, voluntarios y comunidades durante la emergencia.

Antes de tomar decisiones, verifica siempre la información con familiares, fuentes oficiales o contactos directos.

<b>Cómo usarlo</b>
• Escribe un nombre directamente para buscar.
• /buscar nombre — buscar por nombre
• /buscar V12345678 — buscar por cédula
• /lista — ver lista de personas encontradas
• /fuentes — fuentes y limitaciones
• /sugerencia — enviar correcciones o comentarios
• /cancelar — cancelar una operación

Código fuente:
https://github.com/edwinvrgs/found-people-ve-bot`;
}
function menuButtons(): InlineButton[][] {
  return [
    [button("🔎 Buscar", "search"), button("📋 Lista", "list:1")],
  ];
}

async function askForSearch(chatId: number) {
  setPendingChatAction(chatId, { kind: "search" });
  return sendMessage(chatId, "Escribe el nombre, apellido o cédula.\n\nEjemplos: Maria Perez · V12345678", [[button("📋 Ver lista", "list:1")]]);
}

async function handleSourceCommand(message: NonNullable<TelegramUpdate["message"]>, text: string) {
  await incrementMetric("telegram_source");
  const id = commandPayload(text);
  if (!id) return sendMessage(message.chat.id, sourceText());

  const person = await getPersonDetails(resolvePersonId(id));
  if (!person) return sendMessage(message.chat.id, "No encontré ese registro.");
  return sendMessage(message.chat.id, `ℹ️ <b>Fuente del registro</b>

${formatAdminPerson(person)}
`);
}

function sourceText() {
  return `ℹ️ <b>Sobre las fuentes</b>

Este bot centraliza registros consultables y enlazados a su fuente. El crédito de los datos públicos corresponde a quienes los recopilan, transcriben, publican y verifican durante la emergencia.

Fuentes actuales:
• https://github.com/ecrespo/OCR-data_Terremoto_Venezuela_24062026
• https://venezuelatebusca.com/
• https://desaparecidosterremotovenezuela.com/
• https://encuentralos.tecnosoft.dev/

Cada resultado muestra un enlace cuando está disponible. La información pública ayuda en la emergencia, pero no reemplaza confirmación familiar, canales oficiales o la fuente original.

Si ves un error, escribe /sugerencia para reportarlo.`;
}

async function handleFeedbackCommand(message: NonNullable<TelegramUpdate["message"]>, text: string) {
  const feedback = commandPayload(text);
  if (!feedback) {
    setPendingChatAction(message.chat.id, { kind: "feedback" });
    return sendMessage(message.chat.id, "Claro. Escríbeme tu sugerencia en el próximo mensaje.");
  }
  return submitFeedback(message, feedback);
}

async function submitFeedback(message: NonNullable<TelegramUpdate["message"]>, feedback: string) {
  if (feedback.length < 3) {
    setPendingChatAction(message.chat.id, { kind: "feedback" });
    return sendMessage(message.chat.id, "El mensaje está muy corto. Escríbeme un poco más de detalle, por favor.");
  }

  capture(telegramEvent("feedback_submitted", message.chat.id), telegramDistinctId(message.chat.id, message.from), { textLengthBucket: lengthBucket(feedback.length) });
  await notifyAdmin(`💬 <b>Feedback recibido</b>

${formatReporter(message)}

<b>Mensaje:</b>
${escapeHtml(feedback)}`);
  return sendMessage(message.chat.id, "Gracias. Recibí tu sugerencia y se la envié al equipo.");
}


async function sendPeoplePage(chatId: number, page: number, messageId?: number, user?: TelegramUser) {
  const result = await listPublicPeople(page, 5);
  capture(telegramEvent("list_viewed", chatId), telegramDistinctId(chatId, user), { page, total: result.total, resultCount: result.items.length });
  const text = formatPeopleList(result.items, `Personas encontradas (${result.page}/${result.totalPages})`, result.total);
  const buttons = paginationButtons("list", result.page, result.totalPages);
  return messageId ? editMessage(chatId, messageId, text, buttons) : sendMessage(chatId, text, buttons);
}

async function sendSearchResults(chatId: number, query: string, message?: NonNullable<TelegramUpdate["message"]>) {
  const parsed = TelegramSearchQuerySchema.safeParse(query);
  if (!parsed.success) return sendMessage(chatId, "Escribe al menos 2 caracteres y máximo 80 para buscar. Puedes buscar por nombre o cédula.");

  await incrementMetric("telegram_search");
  const result = await searchPublicPeople(parsed.data, 1, 5);
  const documentSearch = documentSearchLabel(parsed.data);
  const distinctId = telegramDistinctId(chatId, message?.from);
  capture(telegramEvent("search_performed", chatId), distinctId, {
    queryLengthBucket: lengthBucket(parsed.data.length),
    queryType: documentSearch ? "document" : "name",
    resultCount: result.items.length,
    total: result.total,
  });
  captureSearchMatched({
    surface: "telegram",
    total: result.total,
    resultCount: result.items.length,
    page: 1,
    pageSize: 5,
    query: parsed.data,
    distinctId,
  });
  const displayQuery = documentSearch ?? `“${escapeHtml(parsed.data)}”`;
  const text = result.total === 0
    ? `No encontré resultados para ${displayQuery}.\n\nPrueba con menos caracteres o revisa la lista completa.`
    : formatPeopleList(result.items, `Resultados para ${displayQuery}`, result.total);

  return sendMessage(chatId, text, [[button("🔎 Buscar", "search"), button("📋 Lista", "list:1")]]);
}


function formatReporter(message: NonNullable<TelegramUpdate["message"]>) {
  const user = message.from;
  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Usuario sin nombre";
  const username = user?.username ? `@${user.username}` : "sin username";
  return `<b>Usuario:</b> ${escapeHtml(displayName)} (${escapeHtml(username)})\n<b>User ID:</b> ${escapeHtml(String(user?.id ?? "desconocido"))}\n<b>Chat ID:</b> ${escapeHtml(String(message.chat.id))}`;
}

export async function notifyAdmin(text: string, inlineKeyboard?: InlineButton[][]) {
  if (!env.adminChatId) return;
  await sendMessage(env.adminChatId, text, inlineKeyboard);
}


function formatMetrics(metrics: Record<string, number>) {
  const entries = Object.entries(metrics);
  if (entries.length === 0) return "sin métricas todavía";
  return entries.map(([key, value]) => `${escapeHtml(key)}: ${value}`).join("\n");
}

function formatAdminPeopleList(items: FoundPerson[], title: string) {
  const lines = items.map(formatAdminPerson);
  return truncate(`${escapeHtml(title)}\n\n${lines.join("\n\n")}`, 3500);
}

export function formatAdminPerson(person: FoundPerson) {
  return [
    `<b>${escapeHtml(person.fullName)}</b>`,
    `ID: <code>${escapeHtml(rememberPersonId(person.id))}</code>`,
    person.relevantInfo ? escapeHtml(truncate(person.relevantInfo, 180)) : null,
    `<a href="${escapeHtmlAttribute(person.sourceUrl)}">Ver fuente</a>`,
  ].filter(Boolean).join("\n");
}

function formatPeopleList(items: FoundPerson[], title: string, total: number) {
  if (items.length === 0) return `${escapeHtml(title)}\n\nNo hay personas para mostrar.`;

  const lines = items.map((person, index) => [
    `${index + 1}. <b>${escapeHtml(person.fullName)}</b>`,
    person.relevantInfo ? escapeHtml(truncate(person.relevantInfo, 220)) : null,
    `<a href="${escapeHtmlAttribute(person.sourceUrl)}">Fuente</a>`,
  ].filter(Boolean).join("\n"));

  return truncate(`${escapeHtml(title)}\nTotal: ${total}\n\n${lines.join("\n\n")}`, 3500);
}

function paginationButtons(prefix: string, page: number, totalPages: number): InlineButton[][] {
  const row: InlineButton[] = [];
  if (page > 1) row.push(button("⬅️", `${prefix}:${page - 1}`));
  if (page < totalPages) row.push(button("➡️", `${prefix}:${page + 1}`));
  return row.length ? [row] : [];
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

