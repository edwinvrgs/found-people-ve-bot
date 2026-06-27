import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ANALYTICS_HASH_SALT = "test-salt";

const { telegramChatInput } = await import("./bot.js");

describe("telegram chat registry input", () => {
  it("keeps only the raw chat ID and minimal Telegram metadata for future broadcasts", () => {
    const input = telegramChatInput({ id: 123, type: "private" }, { id: 456, username: "EdVargas" });

    assert.equal(input.chatId, 123);
    assert.equal(input.chatType, "private");
    assert.equal(input.username, "@edvargas");
    assert.equal("chatIdHash" in input, false);
    assert.equal("userIdHash" in input, false);
  });
});
