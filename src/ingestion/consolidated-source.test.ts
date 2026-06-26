import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consolidatedRowToCandidate, parseConsolidatedCsv } from "./consolidated-source.js";

describe("root consolidated injured list source", () => {
  it("parses public CSV rows with accents, quoted commas, and multiline cells", () => {
    const rows = parseConsolidatedCsv([
      "Hospital / Área,Nombre,Edad,Cédula,Procedencia / Zona,Servicio / Lista,Nota",
      'Hosp. José Gregorio Hernández (Magallanes),Álvarez Maikeli,,300454425,La Guaira,Reporte pacientes atendidos,"Politraumatismo, observación"',
      'Hosp. Miguel Pérez Carreño (Caracas / La Yaguara),Ana Fernandez,,25699054,,Listas manuscritas legibles,"Transcripción de manuscrito;\nrevisar contra foto si es crítico"',
    ].join("\n"));

    assert.equal(rows.length, 2);
    assert.equal(rows[0].rowNumber, 2);
    assert.equal(rows[0].cells["hospital / area"], "Hosp. José Gregorio Hernández (Magallanes)");
    assert.equal(rows[0].cells.nombre, "Álvarez Maikeli");
    assert.equal(rows[0].cells.cedula, "300454425");
    assert.equal(rows[0].cells.nota, "Politraumatismo, observación");
    assert.equal(rows[1].cells.nota, "Transcripción de manuscrito; revisar contra foto si es crítico");
  });

  it("converts rows into privacy-safe ingestion candidates", () => {
    const [row] = parseConsolidatedCsv([
      "Hospital / Área,Nombre,Edad,Cédula,Procedencia / Zona,Servicio / Lista,Nota",
      "Hosp. Miguel Pérez Carreño (Caracas / La Yaguara),Ana Fernandez,,25699054,,Listas manuscritas legibles,Transcripción de manuscrito; revisar contra foto si es crítico",
    ].join("\n"));

    const candidate = consolidatedRowToCandidate(row);

    assert.ok(candidate);
    assert.equal(candidate.fullName, "Ana Fernandez");
    assert.equal(candidate.documentId, "25699054");
    assert.equal(candidate.sourceUrl, "https://github.com/ecrespo/OCR-data_Terremoto_Venezuela_24062026/blob/main/consolidado.csv#L2");
    assert.equal(candidate.raw?.provider, "github_ocr_consolidated_csv");
    assert.equal(candidate.raw?.source, "consolidated_injured_list");
    assert.match(candidate.relevantInfo ?? "", /Hosp\. Miguel Pérez Carreño/);
    assert.doesNotMatch(candidate.relevantInfo ?? "", /25699054/);
    assert.match(candidate.sourceHash, /^[a-f0-9]{64}$/);
  });

  it("uses the row URL and keeps empty document IDs private", () => {
    const [row] = parseConsolidatedCsv([
      "Hospital / Área,Nombre,Edad,Cédula,Procedencia / Zona,Servicio / Lista,Nota",
      "Hosp. Gral. Dr. José María Vargas (La Guaira),Abraham Gonzalez,7,,Caribe,Lista pacientes atendidos,",
    ].join("\n"));

    const candidate = consolidatedRowToCandidate(row);

    assert.ok(candidate);
    assert.equal(candidate.documentId, null);
    assert.equal(candidate.sourceUrl, "https://github.com/ecrespo/OCR-data_Terremoto_Venezuela_24062026/blob/main/consolidado.csv#L2");
  });

  it("normalizes page markers accidentally appended to names", () => {
    const [row] = parseConsolidatedCsv([
      "Hospital / Área,Nombre,Edad,Cédula,Procedencia / Zona,Servicio / Lista,Nota",
      "Hosp. Dr. Domingo Luciani (Llanito),Guavini Efren P.2,,,,Registro hospitalario,",
    ].join("\n"));

    const candidate = consolidatedRowToCandidate(row);

    assert.ok(candidate);
    assert.equal(candidate.fullName, "Guavini Efren");
  });
});
