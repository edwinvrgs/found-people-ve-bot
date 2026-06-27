import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFoundPeopleSearchCriteria, normalizeDocumentId, normalizeSearchText, searchCriteriaKind } from "./found-people-search.js";

describe("found people search criteria", () => {
  it("normalizes names for name-only searches", () => {
    assert.deepEqual(buildFoundPeopleSearchCriteria({ q: "  María   Pérez  " }), { name: "María Pérez" });
  });

  it("extracts Venezuelan document digits from cédula-only searches", () => {
    assert.deepEqual(buildFoundPeopleSearchCriteria({ q: "V-12.345.678" }), { documentId: "12345678" });
  });

  it("supports combined name and cédula searches from one query", () => {
    assert.deepEqual(buildFoundPeopleSearchCriteria({ q: "María Pérez V-12.345.678" }), {
      name: "María Pérez",
      documentId: "12345678",
    });
  });

  it("supports explicit API name plus documentId filters", () => {
    assert.deepEqual(buildFoundPeopleSearchCriteria({ name: "María Pérez", documentId: "12.345.678" }), {
      name: "María Pérez",
      documentId: "12345678",
    });
  });

  it("classifies criteria for analytics", () => {
    assert.equal(searchCriteriaKind({}), "list");
    assert.equal(searchCriteriaKind({ name: "María" }), "name");
    assert.equal(searchCriteriaKind({ documentId: "12345678" }), "document");
    assert.equal(searchCriteriaKind({ name: "María", documentId: "12345678" }), "name_document");
  });

  it("rejects document IDs outside the expected cédula length", () => {
    assert.equal(normalizeDocumentId("12345"), undefined);
    assert.equal(normalizeDocumentId("1234567890"), undefined);
  });

  it("returns undefined for blank normalized search text", () => {
    assert.equal(normalizeSearchText("   \n\t "), undefined);
  });
});
