import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

export type TelegramChatInput = {
  chatId?: number | null;
  username?: string | null;
  chatType?: string | null;
  firstSeenAt?: Date | string | null;
  lastSeenAt?: Date | string | null;
};

type NormalizedTelegramChatInput = {
  chatId: number | null;
  username: string | null;
  chatType: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

type TelegramChatIdentityRow = {
  id: string;
  chat_id: bigint | null;
};

export function telegramChatBroadcastCandidateWhereSql() {
  return Prisma.sql`blocked_at IS NULL AND broadcast_opt_out = false`;
}

export async function upsertTelegramChat(input: TelegramChatInput) {
  const normalized = normalizeTelegramChatInput(input);
  if (!hasTelegramChatIdentity(normalized)) return null;

  const existing = await findExistingTelegramChatRows(normalized);
  const target = chooseTargetTelegramChat(existing);

  if (target) {
    const duplicateIds = existing.filter((row) => row.id !== target.id).map((row) => row.id);
    if (duplicateIds.length > 0) await deleteTelegramChatRows(duplicateIds);
    await updateTelegramChat(target.id, normalized);
    return target.id;
  }

  return insertTelegramChat(normalized);
}

export async function upsertTelegramChats(inputs: TelegramChatInput[]) {
  let upserted = 0;
  for (const input of inputs) {
    const id = await upsertTelegramChat(input);
    if (id) upserted += 1;
  }
  return upserted;
}

export function normalizeTelegramChatInput(input: TelegramChatInput): NormalizedTelegramChatInput {
  const now = new Date();
  const lastSeenAt = toDate(input.lastSeenAt) ?? now;
  const firstSeenAt = toDate(input.firstSeenAt) ?? lastSeenAt;

  return {
    chatId: input.chatId ?? null,
    username: normalizeUsername(input.username),
    chatType: cleanText(input.chatType) ?? "unknown",
    firstSeenAt,
    lastSeenAt,
  };
}

function hasTelegramChatIdentity(input: NormalizedTelegramChatInput) {
  return input.chatId !== null;
}

async function findExistingTelegramChatRows(input: NormalizedTelegramChatInput) {
  const filters: Prisma.Sql[] = [];
  if (input.chatId !== null) filters.push(Prisma.sql`chat_id = ${input.chatId}`);
  if (filters.length === 0) return [];

  return prisma.$queryRaw<TelegramChatIdentityRow[]>`
    SELECT id, chat_id
    FROM telegram_chats
    WHERE ${Prisma.join(filters, " OR ")}`;
}

function chooseTargetTelegramChat(rows: TelegramChatIdentityRow[]) {
  return rows.find((row) => row.chat_id !== null) ?? rows[0] ?? null;
}

async function updateTelegramChat(id: string, input: NormalizedTelegramChatInput) {
  await prisma.$executeRaw`
    UPDATE telegram_chats SET
      chat_id = COALESCE(telegram_chats.chat_id, ${input.chatId}::bigint),
      username = COALESCE(${input.username}, telegram_chats.username),
      chat_type = ${input.chatType},
      first_seen_at = LEAST(telegram_chats.first_seen_at, ${input.firstSeenAt}),
      last_seen_at = GREATEST(telegram_chats.last_seen_at, ${input.lastSeenAt}),
      updated_at = now()
    WHERE id = ${id}::uuid`;
}

async function deleteTelegramChatRows(ids: string[]) {
  await prisma.$executeRaw`
    DELETE FROM telegram_chats
    WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
}

async function insertTelegramChat(input: NormalizedTelegramChatInput) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO telegram_chats (
      chat_id,
      username,
      chat_type,
      first_seen_at,
      last_seen_at
    ) VALUES (
      ${input.chatId}::bigint,
      ${input.username},
      ${input.chatType},
      ${input.firstSeenAt},
      ${input.lastSeenAt}
    )
    ON CONFLICT (chat_id) DO UPDATE SET
      username = COALESCE(EXCLUDED.username, telegram_chats.username),
      chat_type = EXCLUDED.chat_type,
      first_seen_at = LEAST(telegram_chats.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(telegram_chats.last_seen_at, EXCLUDED.last_seen_at),
      updated_at = now()
    RETURNING id`;

  return rows[0]?.id ?? null;
}

function cleanText(value: string | null | undefined) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function normalizeUsername(value: string | null | undefined) {
  const cleaned = cleanText(value)?.replace(/^@/, "").toLowerCase();
  return cleaned ? `@${cleaned}` : null;
}

function toDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}
