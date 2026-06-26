import { createHash } from "node:crypto";
import {
  deletePersonById,
  deletePersonBySourceUrl,
  getFoundPeopleStats,
  getPersonById,
  listPeople,
  listPeopleExternal,
  listRecentCitizenReports,
  searchPeople,
  searchPeopleByDocument,
  searchPeopleByName,
  searchPeopleExternal,
  updatePersonStatus,
  upsertPeople,
  type UpsertPersonInput,
} from "../repositories/found-people-repository.js";
import type { RecordStatus } from "../db.js";

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

export type CitizenReportInput = {
  fullName: string;
  location: string;
  sourceUrl: string;
  submittedSourceUrl?: string | null;
  messageId: number;
  chatId: number;
  reporter: Record<string, unknown>;
};

export type ExternalReportOptions = {
  idempotencyKey?: string;
  publicBaseUrl: string;
};

export function listPublicPeople(page: number, pageSize: number) {
  return listPeople(page, pageSize);
}

export function searchPublicPeople(name: string, page: number, pageSize: number) {
  return searchPeople(name, page, pageSize);
}

export function listExternalFoundPeople(input: ExternalFoundPeopleSearch) {
  const { page, pageSize, q, name, documentId } = input;
  if (documentId) return searchPeopleByDocument(documentId, page, pageSize);
  if (name) return searchPeopleByName(name, page, pageSize);
  if (q) return searchPeopleExternal(q, page, pageSize);
  return listPeopleExternal(page, pageSize);
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

export function setPersonStatus(id: string, status: RecordStatus) {
  return updatePersonStatus(id, status);
}

export function getPersonDetails(id: string) {
  return getPersonById(id);
}

export function listCitizenReports(limit: number, status?: RecordStatus) {
  return listRecentCitizenReports(limit, status);
}

export function getStats() {
  return getFoundPeopleStats();
}

export async function createCitizenReport(input: CitizenReportInput) {
  const relevantInfo = `Reporte ciudadano — ubicación: ${input.location}${input.submittedSourceUrl ? " — fuente enviada por usuario" : " — sin enlace externo"}`;
  const [person] = await upsertPeople([{
    fullName: input.fullName,
    relevantInfo,
    sourceUrl: input.sourceUrl,
    status: "citizen_report",
    sourceHash: `telegram-report:${input.chatId}:${input.messageId}`,
    raw: {
      provider: "telegram_report",
      location: input.location,
      submittedSourceUrl: input.submittedSourceUrl ?? null,
      reporter: input.reporter,
      messageId: input.messageId,
      chatId: input.chatId,
    },
  }]);

  return person;
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
    status: "citizen_report",
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
