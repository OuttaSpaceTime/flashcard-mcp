import type { PrismaClient } from "@prisma/client";
import { normalizeDates } from "./normalize.js";
import { syncSchema } from "./schema-sync.js";

/**
 * What every start of the CLI, the MCP server and the app server does to the
 * database before using it: bring its tables up to the schema (schema-sync.ts),
 * then make its dates uniform (normalize.ts), in that order, since the second
 * reads the tables the first makes. Both are cheap when there is nothing to do.
 */
export async function prepareDatabase(db: PrismaClient): Promise<{ schemaPushed: boolean }> {
  const schemaPushed = await syncSchema(db);
  await normalizeDates(db);
  return { schemaPushed };
}
