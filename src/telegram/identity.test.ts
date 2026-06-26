import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.ANALYTICS_HASH_SALT = "test-salt";

const {
  legacyTelegramUsernameDistinctId,
  normalizeTelegramUsername,
  telegramAnalyticsProperties,
  telegramDistinctId,
} = await import("./identity.js");

describe("Telegram analytics identity", () => {
  it("uses a stable hashed Telegram user ID instead of the mutable username", () => {
    const user = { id: 123, username: "OldName" };

    assert.equal(telegramDistinctId(999, user), telegramDistinctId(999, { ...user, username: "NewName" }));
    assert.match(telegramDistinctId(999, user), /^telegram_user:[a-f0-9]{32}$/);
    assert.notEqual(telegramDistinctId(999, user), "telegram:@oldname");
  });

  it("falls back to chat identity only when Telegram user data is unavailable", () => {
    assert.match(telegramDistinctId(999), /^telegram_chat:[a-f0-9]{32}$/);
  });

  it("keeps the username as a property without using it as the distinct ID", () => {
    const properties = telegramAnalyticsProperties(999, { id: 123, username: "Edwin" });

    assert.equal(properties.telegramHasUsername, true);
    assert.equal(properties.telegramUsername, "@edwin");
    assert.match(properties.telegramUsernameHash ?? "", /^[a-f0-9]{32}$/);
    assert.notEqual(telegramDistinctId(999, { id: 123, username: "Edwin" }), "telegram:@edwin");
  });

  it("can address the previous username-based distinct ID for PostHog aliasing", () => {
    assert.equal(normalizeTelegramUsername("@MixedCase"), "@mixedcase");
    assert.equal(legacyTelegramUsernameDistinctId("MixedCase"), "telegram:@mixedcase");
  });
});
