import { createHash } from "node:crypto";
import {
  deletePersonById,
  deletePersonBySourceUrl,
  getFoundPeopleStats,
  getPersonById,
  listPeople,
  listPeopleExternal,
  searchPeople,
  searchPeopleByDocument,
  searchPeopleByName,
  searchPeopleExternal,
  upsertPeople,
  type UpsertPersonInput,
} from "../repositories/found-people-repository.js";
import { externalFoundPeopleApiConfigured, listFoundPeopleFromApi, toPublicFoundPersonPage } from "./found-people-api-client.js";

export type ExternalFoundPeopleSearch = {
  page: number;
  pageSize: number;
  q?: string;
  name?: string;
  documentId?: string;
};

export type ExternalReportInput = {
  fullName: string;
  location: string;
  sourceUrl?: string;
  notes?: string;
  reporter?: {
    name?: string;
    contact?: string;
    service?: string;
  };
};

export type ExternalReportOptions = {
  idempotencyKey?: string;
  publicBaseUrl: string;
};

export async function listPublicPeople(page: number, pageSize: number) {
  if (externalFoundPeopleApiConfigured()) return toPublicFoundPersonPage(await listFoundPeopleFromApi({ page, pageSize }));
  return listPeople(page, pageSize);
}

export async function searchPublicPeople(query: string, page: number, pageSize: number) {
  if (externalFoundPeopleApiConfigured()) return toPublicFoundPersonPage(await listFoundPeopleFromApi(searchInputFromQuery(query, page, pageSize)));
  return searchPeople(query, page, pageSize);
}

export async function listExternalFoundPeople(input: ExternalFoundPeopleSearch) {
  const { page, pageSize, q, name, documentId } = input;
  if (externalFoundPeopleApiConfigured()) return listFoundPeopleFromApi(input);
  if (documentId) return searchPeopleByDocument(documentId, page, pageSize);
  if (name) return searchPeopleByName(name, page, pageSize);
  if (q) return searchPeopleExternal(q, page, pageSize);
  return listPeopleExternal(page, pageSize);
}

function searchInputFromQuery(query: string, page: number, pageSize: number): ExternalFoundPeopleSearch {
  const documentId = query.replace(/\D/g, "");
  if (documentId.length >= 6 && documentId.length <= 9) return { page, pageSize, documentId };
  return { page, pageSize, name: query };
}

export function ingestPeople(people: UpsertPersonInput[]) {
  return upsertPeople(people);
}

export function removePeopleBySourceUrl(sourceUrl: string) {
  return deletePersonBySourceUrl(sourceUrl);
}

export function removePersonById(id: string) {
  return deletePersonById(id);
}

export function getPersonDetails(id: string) {
  return getPersonById(id);
}

export function getStats() {
  return getFoundPeopleStats();
}

export function buildExternalReportUpsertInput(payload: ExternalReportInput, options: ExternalReportOptions): UpsertPersonInput {
  const idempotencyKey = options.idempotencyKey?.trim().slice(0, 120) ?? "";
  const stableHashInput = idempotencyKey || JSON.stringify({ fullName: payload.fullName, location: payload.location, sourceUrl: payload.sourceUrl ?? null });
  const reportHash = createHash("sha256").update(stableHashInput).digest("hex");
  const sourceUrl = payload.sourceUrl ?? `${options.publicBaseUrl}/api/v1/found-people/reports/${reportHash.slice(0, 16)}`;
  const relevantInfo = [
    `Reporte externo — ubicación: ${payload.location}`,
    payload.notes ? `nota: ${payload.notes}` : null,
    payload.sourceUrl ? "fuente enviada por servicio externo" : "sin enlace externo",
  ].filter(Boolean).join(" — ");

  return {
    fullName: payload.fullName,
    relevantInfo,
    sourceUrl,
    sourceHash: `external-report:${reportHash}`,
    raw: {
      provider: "external_report_api",
      location: payload.location,
      notes: payload.notes ?? null,
      reporter: payload.reporter ?? null,
      submittedSourceUrl: payload.sourceUrl ?? null,
      idempotencyKeyHash: idempotencyKey ? createHash("sha256").update(idempotencyKey).digest("hex") : null,
    },
  };
}

export async function createExternalReport(payload: ExternalReportInput, options: ExternalReportOptions) {
  const [person] = await upsertPeople([buildExternalReportUpsertInput(payload, options)]);

  return person;
}
