import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

let prisma: PrismaClient | undefined;

export function createClient(url?: string): PrismaClient {
  const dbUrl = url ?? process.env["DATABASE_URL"] ?? "file:./prisma/master.db";
  const adapter = new PrismaBetterSqlite3({ url: dbUrl });
  return new PrismaClient({ adapter });
}

export function getDb(): PrismaClient {
  prisma ??= createClient();
  return prisma;
}

export function setDb(client: PrismaClient): void {
  prisma = client;
}
