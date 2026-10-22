import { isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

/** The repo root, from src/db or build/db alike. */
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

let prisma: PrismaClient | undefined;
const clientUrls = new WeakMap<PrismaClient, string>();

/**
 * The database's `file:` URL: DATABASE_URL, else prisma/master.db. A relative
 * path is taken from the repo root, as prisma.config.ts does, never from the
 * working directory, so a process started elsewhere opens the same deck.
 */
export function databaseUrl(): string {
  return absoluteFileUrl(process.env["DATABASE_URL"] ?? "file:./prisma/master.db");
}

/** The database file `databaseUrl()` names. */
export function databaseFile(): string {
  return databaseUrl().slice("file:".length);
}

function absoluteFileUrl(url: string): string {
  if (!url.startsWith("file:")) return url;
  const path = url.slice("file:".length);
  return isAbsolute(path) ? url : `file:${resolve(ROOT, path)}`;
}

export function createClient(url: string = databaseUrl()): PrismaClient {
  const dbUrl = absoluteFileUrl(url);
  const client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });
  clientUrls.set(client, dbUrl);
  return client;
}

/** The URL a client was created with, so a schema push targets the file it reads. */
export function clientUrl(db: PrismaClient): string {
  return clientUrls.get(db) ?? databaseUrl();
}

export function getDb(): PrismaClient {
  prisma ??= createClient();
  return prisma;
}

export function setDb(client: PrismaClient): void {
  prisma = client;
}
