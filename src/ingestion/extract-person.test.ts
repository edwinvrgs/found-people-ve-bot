import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractFoundPerson, looksLikePersonName } from "./extract-person.js";

describe("found-person extraction smoke tests", () => {
  it("extracts likely names from found/rescued text patterns", () => {
    assert.deepEqual(
      extractFoundPerson("Localizada María Fernanda Pérez."),
      { fullName: "María Fernanda Pérez" },
    );
    assert.deepEqual(
      extractFoundPerson("rescatado a Carlos Alberto Pérez"),
      { fullName: "Carlos Alberto Pérez" },
    );
  });

  it("rejects obvious non-person names and social handles", () => {
    assert.equal(looksLikePersonName("Terremoto Venezuela"), false);
    assert.equal(looksLikePersonName("@usuario encontrado"), false);
    assert.equal(looksLikePersonName("Maria 123"), false);
  });
});
