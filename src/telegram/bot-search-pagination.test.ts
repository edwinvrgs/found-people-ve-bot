import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchResultButtons } from "./bot.js";

describe("Telegram search pagination buttons", () => {
  it("adds a next-page button for paginated /buscar results", () => {
    assert.deepEqual(searchResultButtons("abc123", 1, 3), [
      [{ text: "➡️", callback_data: "search_page:abc123:2" }],
      [
        { text: "🔎 Buscar", callback_data: "search" },
        { text: "📋 Lista", callback_data: "list:1" },
      ],
    ]);
  });

  it("adds previous and next buttons on middle search result pages", () => {
    assert.deepEqual(searchResultButtons("abc123", 2, 3)[0], [
      { text: "⬅️", callback_data: "search_page:abc123:1" },
      { text: "➡️", callback_data: "search_page:abc123:3" },
    ]);
  });
});
