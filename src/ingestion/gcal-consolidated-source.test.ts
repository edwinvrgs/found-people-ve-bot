import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consolidatedRowToCandidate, parseConsolidatedCsv } from "./gcal-consolidated-source.js";

const SHEET = {
  spreadsheetId: "sheet-id",
  gid: "123",
  url: "https://docs.google.com/spreadsheets/d/sheet-id/edit?gid=123#gid=123",
};

describe("GCal consolidated injured list source", () => {
  it("parses public CSV rows with accents, quoted commas, and multiline cells", () => {
    const rows = parseConsolidatedCsv([
      "Hospital,Nombre,Edad,Cédula,Procedencia,Servicio/Lista,Estado,Nota,Fuente",
      'Hospital Dr. José Gregorio Hernández / Magallanes,Álvarez Maikeli,,300454425,La Guaira,Reporte pacientes atendidos,Paciente,"Politraumatismo, observación",',
      'Hospital Miguel Pérez Carreño,Ana Fernandez,,25699054,,Listas manuscritas legibles,Paciente,"Transcripción de manuscrito;\nrevisar contra foto si es crítico",https://example.com/source',
    ].join("\n"));

    assert.equal(rows.length, 2);
    assert.equal(rows[0].rowNumber, 2);
    assert.equal(rows[0].cells.hospital, "Hospital Dr. José Gregorio Hernández / Magallanes");
    assert.equal(rows[0].cells.nombre, "Álvarez Maikeli");
    assert.equal(rows[0].cells.cedula, "300454425");
    assert.equal(rows[0].cells.nota, "Politraumatismo, observación");
    assert.equal(rows[1].cells.nota, "Transcripción de manuscrito; revisar contra foto si es crítico");
  });

  it("converts rows into privacy-safe ingestion candidates", () => {
    const [row] = parseConsolidatedCsv([
      "Hospital,Nombre,Edad,Cédula,Procedencia,Servicio/Lista,Estado,Nota,Fuente",
      "Hospital Miguel Pérez Carreño,Ana Fernandez,,25699054,,Listas manuscritas legibles,Paciente,Transcripción de manuscrito; revisar contra foto si es crítico,https://example.com/source",
    ].join("\n"));

    const candidate = consolidatedRowToCandidate(row, SHEET);

    assert.ok(candidate);
    assert.equal(candidate.fullName, "Ana Fernandez");
    assert.equal(candidate.documentId, "25699054");
    assert.equal(candidate.sourceUrl, "https://example.com/source");
    assert.equal(candidate.raw?.provider, "github_ocr_gcal_consolidated");
    assert.equal(candidate.raw?.source, "gcal_consolidated_injured_list");
    assert.match(candidate.relevantInfo ?? "", /Hospital Miguel Pérez Carreño/);
    assert.doesNotMatch(candidate.relevantInfo ?? "", /25699054/);
    assert.match(candidate.sourceHash, /^[a-f0-9]{64}$/);
  });

  it("falls back to a specific sheet row URL when no source link is present", () => {
    const [row] = parseConsolidatedCsv([
      "Hospital,Nombre,Edad,Cédula,Procedencia,Servicio/Lista,Estado,Nota,Fuente",
      "Hospital General Regional Dr. José María Vargas - IVSS La Guaira,Abraham Gonzalez,7,,Caribe,Lista pacientes atendidos,Paciente,,",
    ].join("\n"));

    const candidate = consolidatedRowToCandidate(row, SHEET);

    assert.ok(candidate);
    assert.equal(candidate.documentId, null);
    assert.equal(candidate.sourceUrl, "https://docs.google.com/spreadsheets/d/sheet-id/edit?gid=123#gid=123&range=A2:I2");
  });
});
