import { prisma } from "./prisma.js";

export type RecordStatus = "verified" | "citizen_report" | "needs_review" | "removed";

export type FoundPerson = {
  id: string;
  fullName: string;
  relevantInfo: string | null;
  sourceUrl: string;
  status: RecordStatus;
};

export type FoundPersonExternal = FoundPerson & { documentId: string | null };

export type FoundPersonWithMetadata = FoundPerson & {
  createdAt: string;
  updatedAt: string;
  provider: string | null;
};

export async function disconnectDatabase() {
  await prisma.$disconnect();
}

export {
  deletePersonById,
  deletePersonBySourceUrl,
  getBotMetrics,
  getFoundPeopleStats,
  getPersonById,
  incrementMetric,
  listPeople,
  listPeopleExternal,
  listRecentCitizenReports,
  searchPeople,
  searchPeopleByDocument,
  searchPeopleByName,
  searchPeopleExternal,
  updatePersonStatus,
  upsertPeople,
} from "./repositories/found-people-repository.js";
