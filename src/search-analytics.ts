import { capture } from "./analytics.js";
import { lengthBucket } from "./http/schemas.js";

export function captureSearchMatched(input: { surface: "telegram"; total: number; resultCount: number; page: number; pageSize: number; query: string; distinctId: string }) {
  if (input.total <= 0) return;
  const documentSearch = Boolean(documentSearchLabel(input.query));
  capture("search_matched", input.distinctId, {
    surface: input.surface,
    queryLengthBucket: lengthBucket(input.query.length),
    queryType: documentSearch ? "document" : "name",
    resultCount: input.resultCount,
    total: input.total,
    page: input.page,
    pageSize: input.pageSize,
  });
}

export function documentSearchLabel(query: string) {
  const digits = query.replace(/\D/g, "");
  if (digits.length < 5) return null;
  return `cédula terminada en ${escapeHtml(digits.slice(-4))}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
