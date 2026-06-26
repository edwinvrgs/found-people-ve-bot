import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPersonSpecificSourceUrl, personSpecificSourceUrlMatchKey } from "./source-identity.js";

describe("source identity classification", () => {
  it("treats shared list pages as provenance only", () => {
    const sourceUrl = "https://venezuelatebusca.com/?status=found&page=100";

    assert.equal(isPersonSpecificSourceUrl(sourceUrl), false);
    assert.equal(personSpecificSourceUrlMatchKey(sourceUrl), null);
  });

  it("allows person-specific URLs as automatic match keys", () => {
    const sourceUrl = "https://venezuelatebusca.com/?status=found&page=100#record=abc";

    assert.equal(isPersonSpecificSourceUrl(sourceUrl), true);
    assert.equal(personSpecificSourceUrlMatchKey(sourceUrl), sourceUrl);
  });

  it("supports other explicit profile/person URL patterns", () => {
    assert.equal(isPersonSpecificSourceUrl("https://example.com/persona?persona=123"), true);
    assert.equal(isPersonSpecificSourceUrl("https://example.com/p/abc123"), true);
    assert.equal(isPersonSpecificSourceUrl("https://github.com/org/repo/blob/main/file.md#L42"), true);
  });
});
