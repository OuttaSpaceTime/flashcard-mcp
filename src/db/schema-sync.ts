import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import type { PrismaClient } from "@prisma/client";

/**
 * Keeps a database's tables in step with prisma/schema.prisma, on every start
 * of the CLI, the MCP server and the app server (prepareDatabase), so a
 * schema change never needs a `npx prisma db push` someone has to remember on
 * each machine. That was the plan before, and every reader of a new table had
 * to cope with it missing until the push was run.
 *
 * The database carries the schema it was last pushed with, as a fingerprint
 * of schema.prisma in SQLite's `PRAGMA user_version` (a header field nothing
 * else here uses; 0 on a database never synced). A start compares it with the
 * file's, which costs one pragma; only when they differ does it back the file
 * up beside itself (`<db>.bak-<time>-schema`) and run `prisma db push`, then
 * record the new fingerprint. db push refuses a change that would lose data
 * unless told to accept it, and it is not told: such a change fails the start
 * with Prisma's message and leaves the database as it was, for a person to
 * decide.
 *
 * Not `prisma migrate`: this repo has never kept migrations, every database
 * so far was made by db push, and a migration history would have to be
 * baselined on each machine's existing deck first.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The fingerprint of a schema: 31 bits of its SHA-256, never 0 (0 is "never synced"). */
export function schemaVersion(schema: string): number {
  const v = createHash("sha256").update(schema).digest().readUInt32BE(0) & 0x7fffffff;
  return v === 0 ? 1 : v;
}

export interface SyncOptions {
  schemaPath?: string;
  /** The database's `file:` URL; DATABASE_URL, else the default master.db. */
  dbUrl?: string;
  /** Runs `prisma db push` against the URL (injected by the tests). */
  push?: (dbUrl: string) => void;
}

/** Pushes the schema if the database's fingerprint differs. True when it pushed. */
export async function syncSchema(db: PrismaClient, opts: SyncOptions = {}): Promise<boolean> {
  const want = schemaVersion(readFileSync(opts.schemaPath ?? join(ROOT, "prisma", "schema.prisma"), "utf8"));
  const rows = await db.$queryRawUnsafe<{ user_version: number | bigint }[]>("PRAGMA user_version");
  if (Number(rows[0]?.user_version ?? 0) === want) return false;

  const url = opts.dbUrl ?? process.env["DATABASE_URL"] ?? "file:./prisma/master.db";
  const file = resolve(url.replace(/^file:/, ""));
  if (existsSync(file) && statSync(file).size > 0) {
    copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-schema`);
  }
  (opts.push ?? prismaPush)(`file:${file}`);
  await db.$executeRawUnsafe(`PRAGMA user_version = ${want}`);
  return true;
}

/** `prisma db push`, quietly: the servers' stdout is their protocol. */
function prismaPush(dbUrl: string): void {
  try {
    execFileSync(join(ROOT, "node_modules", ".bin", "prisma"), ["db", "push"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message: string };
    throw new Error(`prisma db push failed for ${dbUrl}:\n${e.stderr?.toString() ?? ""}${e.stdout?.toString() ?? ""}`.trim());
  }
}
