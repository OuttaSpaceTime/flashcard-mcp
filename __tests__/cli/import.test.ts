/**
 * CLI integration tests for the `import` command.
 *
 * These tests spawn the CLI as a real subprocess with a dedicated temp
 * SQLite database, verifying that --ours / --theirs flags are wired
 * correctly end-to-end from flag → conflict argument → DB mutation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createClient } from "../../src/db/client.js";
import { exportToApkg } from "../../src/core/anki-apkg.js";
import type { PrismaClient } from "@prisma/client";

const ROOT = join(import.meta.dirname, "../..");

let tempDir: string;
let dbUrl: string;
let db: PrismaClient;

function runCli(...args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

async function writeApkg(outPath: string, front: string, back: string): Promise<void> {
  await exportToApkg(outPath, [{
    deckName: "React",
    cards: [{
      id: "cli-test-id",
      front,
      back,
      tags: [],
      stability: 5,
      difficulty: 5,
      state: 2, // Review
      reps: 3,
      lapses: 0,
      due: new Date(),
      interval: 5,
      reviews: [],
    }],
  }]);
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cli-import-test-"));
  const dbPath = join(tempDir, "test.db");
  dbUrl = `file:${dbPath}`;

  execSync("npx prisma db push", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  db = createClient(dbUrl);
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.review.deleteMany();
  await db.card.deleteMany();
  await db.deck.deleteMany();
});

describe("import --ours / --theirs (flag parsing)", () => {
  it("exits 1 with an error when both --ours and --theirs are given", () => {
    const { stderr, status } = runCli("import", "irrelevant.apkg", "--ours", "--theirs");
    expect(status).toBe(1);
    expect(stderr).toContain("mutually exclusive");
  });
});

describe("import --theirs / --ours (.apkg)", () => {
  it("default (no flag): skips duplicate, local card unchanged", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const apkgPath = join(tempDir, "default.apkg");
    await writeApkg(apkgPath, "What is JSX?", "Imported answer");

    const { status } = runCli("import", apkgPath);
    expect(status).toBe(0);

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });

  it("--ours: skips duplicate, local card unchanged", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const apkgPath = join(tempDir, "ours.apkg");
    await writeApkg(apkgPath, "What is JSX?", "Imported answer");

    const { status } = runCli("import", apkgPath, "--ours");
    expect(status).toBe(0);

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });

  it("--theirs: overwrites existing card back and scheduling", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const apkgPath = join(tempDir, "theirs.apkg");
    await writeApkg(apkgPath, "What is JSX?", "Imported answer");

    const { status } = runCli("import", apkgPath, "--theirs");
    expect(status).toBe(0);

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Imported answer");
  });

  it("--theirs: creates new cards that have no local duplicate", async () => {
    await db.deck.create({ data: { name: "React" } });

    const apkgPath = join(tempDir, "new.apkg");
    await writeApkg(apkgPath, "Brand new card", "Some answer");

    const { status, stdout } = runCli("import", apkgPath, "--theirs");
    expect(status).toBe(0);
    expect(stdout).toContain("1 cards");

    const cards = await db.card.findMany();
    expect(cards).toHaveLength(1);
    expect(cards[0].front).toBe("Brand new card");
  });

  it("--theirs --dry-run: reports update count but does not modify", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const apkgPath = join(tempDir, "theirs-dry.apkg");
    await writeApkg(apkgPath, "What is JSX?", "Imported answer");

    const { status, stdout } = runCli("import", apkgPath, "--theirs", "--dry-run");
    expect(status).toBe(0);
    expect(stdout).toContain("Updated: 1");

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });
});

describe("import --theirs / --ours (.txt)", () => {
  it("default (no flag): skips duplicate", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const txtPath = join(tempDir, "default.txt");
    writeFileSync(txtPath, "What is JSX?\tImported answer\n");

    runCli("import", txtPath, "-d", "React");

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });

  it("--ours: skips duplicate", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const txtPath = join(tempDir, "ours.txt");
    writeFileSync(txtPath, "What is JSX?\tImported answer\n");

    runCli("import", txtPath, "-d", "React", "--ours");

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });

  it("--theirs: overwrites back and tags", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer", tags: "old" } });

    const txtPath = join(tempDir, "theirs.txt");
    writeFileSync(txtPath, "#separator:tab\n#tags column:3\nWhat is JSX?\tImported answer\tnew-tag\n");

    const { status } = runCli("import", txtPath, "-d", "React", "--theirs");
    expect(status).toBe(0);

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Imported answer");
    expect(card.tags).toBe("new-tag");
  });

  it("--theirs --dry-run: reports update count but does not modify", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const txtPath = join(tempDir, "theirs-dry.txt");
    writeFileSync(txtPath, "What is JSX?\tImported answer\n");

    const { status, stdout } = runCli("import", txtPath, "-d", "React", "--theirs", "--dry-run");
    expect(status).toBe(0);
    expect(stdout).toContain("Updated: 1");

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });
});
