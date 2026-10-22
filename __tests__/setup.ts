import { afterAll, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createClient, setDb } from "../src/db/client.js";
import { syncSchema } from "../src/db/schema-sync.js";
import type { PrismaClient } from "@prisma/client";

let tempDir: string;
let testPrisma: PrismaClient;

beforeEach(async () => {
  const db = testPrisma;
  await db.cardNote.deleteMany();
  await db.studySession.deleteMany();
  await db.review.deleteMany();
  await db.card.deleteMany();
  await db.deletedCard.deleteMany();
  await db.deck.deleteMany();
  await db.config.deleteMany();
});

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "flashcard-mcp-test-"));
  // Built the way every start builds the real database (src/db/prepare.ts).
  testPrisma = createClient(`file:${join(tempDir, "test.db")}`);
  await syncSchema(testPrisma);
  setDb(testPrisma);
});

afterAll(async () => {
  await testPrisma.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

export function getTestDb(): PrismaClient {
  return testPrisma;
}
