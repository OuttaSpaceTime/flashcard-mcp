import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createClient, setDb } from "../src/db/client.js";
import type { PrismaClient } from "@prisma/client";

let testDbPath: string;
let testPrisma: PrismaClient;

beforeEach(async () => {
  const db = testPrisma;
  await db.studySession.deleteMany();
  await db.review.deleteMany();
  await db.card.deleteMany();
  await db.deck.deleteMany();
  await db.config.deleteMany();
});

beforeAll(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "master-dev-test-"));
  testDbPath = join(tempDir, "test.db");
  const dbUrl = `file:${testDbPath}`;

  execSync("npx prisma db push", {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  testPrisma = createClient(dbUrl);
  setDb(testPrisma);
});

afterAll(async () => {
  await testPrisma?.$disconnect();
  try {
    rmSync(testDbPath, { force: true });
    rmSync(testDbPath + "-journal", { force: true });
  } catch {
    // cleanup best-effort
  }
});

export function getTestDb(): PrismaClient {
  return testPrisma;
}
