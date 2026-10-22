/**
 * CLI integration tests: the CLI runs as a real subprocess against a
 * dedicated temp SQLite database, so flags are checked end to end, from
 * argument parsing to the rows written.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { State } from "ts-fsrs";
import { createClient } from "../../src/db/client.js";
import { syncSchema } from "../../src/db/schema-sync.js";
import { exportToApkg } from "../../src/core/anki-apkg.js";
import type { PrismaClient } from "@prisma/client";

const ROOT = join(import.meta.dirname, "../..");

let tempDir: string;
let dbUrl: string;
let db: PrismaClient;

function runCli(args: string[], input = ""): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf-8",
    input,
    timeout: 30_000,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
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
      schedule: {
        stability: 5,
        difficulty: 5,
        state: State.Review,
        reps: 3,
        lapses: 0,
        due: new Date(),
        interval: 5,
        lastReview: null,
        suspended: false,
      },
      reviews: [],
    }],
  }]);
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cli-import-test-"));
  dbUrl = `file:${join(tempDir, "test.db")}`;
  db = createClient(dbUrl);
  await syncSchema(db);
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.studySession.deleteMany();
  await db.review.deleteMany();
  await db.card.deleteMany();
  await db.deck.deleteMany();
});

describe("commands", () => {
  it("exits 1 with the message on a failing action", () => {
    const { stderr, status } = runCli(["cards", "list", "--deck", "Missing"]);
    expect(status).toBe(1);
    expect(stderr).toContain('Deck "Missing" not found');
  });
});

describe("study", () => {
  it("--deck studies only that deck and ends the session", async () => {
    const react = await db.deck.create({ data: { name: "React" } });
    const other = await db.deck.create({ data: { name: "Other" } });
    const card = await db.card.create({ data: { deckId: react.id, front: "What is JSX?", back: "Syntax" } });
    await db.card.create({ data: { deckId: other.id, front: "Elsewhere?", back: "Yes" } });

    // Reveal, rate Good, then the input ends.
    const { stdout, status } = runCli(["study", "--deck", "React"], "\n3\n");

    expect(status).toBe(0);
    expect(stdout).toContain("1 cards in queue");
    expect(stdout).not.toContain("Elsewhere?");
    const reviews = await db.review.findMany();
    expect(reviews.map((r) => r.cardId)).toEqual([card.id]);
    const session = await db.studySession.findFirstOrThrow();
    expect(session.endTime).not.toBeNull();
  });

  it("rejects a --limit that is not a number", () => {
    const { stderr, status } = runCli(["study", "--limit", "abc"]);
    expect(status).toBe(1);
    expect(stderr).toContain("--limit");
  });
});

describe("import --ours / --theirs (flag parsing)", () => {
  it("exits 1 with an error when both --ours and --theirs are given", () => {
    const { stderr, status } = runCli(["import", "irrelevant.apkg", "--ours", "--theirs"]);
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

    const { status, stdout } = runCli(["import", apkgPath]);
    expect(status).toBe(0);
    expect(stdout).toContain("Imported: 0 created, 0 updated, 1 duplicates, 0 invalid");

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });

  it("--ours: skips duplicate, local card unchanged", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const apkgPath = join(tempDir, "ours.apkg");
    await writeApkg(apkgPath, "What is JSX?", "Imported answer");

    const { status } = runCli(["import", apkgPath, "--ours"]);
    expect(status).toBe(0);

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });

  it("--theirs: overwrites existing card back and scheduling", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const apkgPath = join(tempDir, "theirs.apkg");
    await writeApkg(apkgPath, "What is JSX?", "Imported answer");

    const { status } = runCli(["import", apkgPath, "--theirs"]);
    expect(status).toBe(0);

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Imported answer");
    expect(card.state).toBe(State.Review);
    expect(card.reps).toBe(3);
  });

  it("--theirs: creates new cards that have no local duplicate", async () => {
    await db.deck.create({ data: { name: "React" } });

    const apkgPath = join(tempDir, "new.apkg");
    await writeApkg(apkgPath, "Brand new card", "Some answer");

    const { status, stdout } = runCli(["import", apkgPath, "--theirs"]);
    expect(status).toBe(0);
    expect(stdout).toContain("1 created");

    const cards = await db.card.findMany();
    expect(cards).toHaveLength(1);
    expect(cards[0].front).toBe("Brand new card");
  });

  it("--theirs --dry-run: reports update count but does not modify", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const apkgPath = join(tempDir, "theirs-dry.apkg");
    await writeApkg(apkgPath, "What is JSX?", "Imported answer");

    const { status, stdout } = runCli(["import", apkgPath, "--theirs", "--dry-run"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Would import: 0 created, 1 updated");

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

    const { stdout } = runCli(["import", txtPath, "-d", "React"]);
    expect(stdout).toContain("Imported: 0 created, 0 updated, 1 duplicates, 0 invalid");

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });

  it("--ours: skips duplicate", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer" } });

    const txtPath = join(tempDir, "ours.txt");
    writeFileSync(txtPath, "What is JSX?\tImported answer\n");

    runCli(["import", txtPath, "-d", "React", "--ours"]);

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });

  it("--theirs: overwrites back and tags", async () => {
    const deck = await db.deck.create({ data: { name: "React" } });
    await db.card.create({ data: { deckId: deck.id, front: "What is JSX?", back: "Local answer", tags: "old" } });

    const txtPath = join(tempDir, "theirs.txt");
    writeFileSync(txtPath, "#separator:tab\n#tags column:3\nWhat is JSX?\tImported answer\tnew-tag\n");

    const { status } = runCli(["import", txtPath, "-d", "React", "--theirs"]);
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

    const { status, stdout } = runCli(["import", txtPath, "-d", "React", "--theirs", "--dry-run"]);
    expect(status).toBe(0);
    expect(stdout).toContain("1 updated");

    const card = await db.card.findFirstOrThrow({ where: { deckId: deck.id } });
    expect(card.back).toBe("Local answer");
  });

  it("without --deck, imports into the deck the file names", async () => {
    const txtPath = join(tempDir, "named.txt");
    writeFileSync(txtPath, "#separator:tab\n#deck:Named\nQ1\tA1\n");

    const { status } = runCli(["import", txtPath]);
    expect(status).toBe(0);

    const card = await db.card.findFirstOrThrow({ include: { deck: true } });
    expect(card.deck.name).toBe("Named");
  });
});
