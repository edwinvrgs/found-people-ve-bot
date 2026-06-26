import { prisma } from "./prisma.js";

export type FoundPerson = {
  id: string;
  fullName: string;
  relevantInfo: string | null;
  sourceUrl: string;
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
  searchPeople,
  searchPeopleByDocument,
  searchPeopleByName,
  searchPeopleExternal,
  upsertPeople,
} from "./repositories/found-people-repository.js";
