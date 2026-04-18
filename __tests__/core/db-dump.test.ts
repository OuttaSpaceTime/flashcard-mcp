import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { dumpDatabase, restoreDatabase } from "../../src/core/db-dump.js";

let workDir: string;
let srcDb: string;
let dumpFile: string;
let restoreDb: string;

function seed(path: string): void {
  execSync("npx prisma db push", {
    env: { ...process.env, DATABASE_URL: `file:${path}` },
    stdio: "pipe",
  });
  const db = new Database(path);
  db.prepare(
    `INSERT INTO Deck (id, name, description, createdAt) VALUES (?, ?, ?, ?)`,
  ).run("deck1", "TestDeck", "d", new Date("2026-01-01").getTime());
  db.prepare(
    `INSERT INTO Card (id, deckId, front, back, tags, type, maturity, due, stability, difficulty, reps, lapses, state, interval, suspended, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "card1",
    "deck1",
    "What's a \"quote\" and 'apostrophe'?\nNewline here",
    "Answer with\ttab",
    "foo,bar",
    "guided",
    "new",
    new Date("2026-02-01").getTime(),
    1.5,
    2.5,
    0,
    0,
    0,
    0,
    0,
    new Date("2026-01-01").getTime(),
    new Date("2026-01-01").getTime(),
  );
  db.close();
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "db-dump-test-"));
  srcDb = join(workDir, "src.db");
  dumpFile = join(workDir, "dump.sql");
  restoreDb = join(workDir, "restored.db");
  seed(srcDb);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("dumpDatabase", () => {
  it("produces a SQL dump with CREATE TABLE and INSERT statements", () => {
    const result = dumpDatabase(srcDb, dumpFile);
    expect(result.rows).toBeGreaterThan(0);
    expect(result.tables).toBeGreaterThan(0);

    const sql = readFileSync(dumpFile, "utf-8");
    expect(sql).toContain("BEGIN TRANSACTION");
    expect(sql).toContain('CREATE TABLE "Deck"');
    expect(sql).toContain('CREATE TABLE "Card"');
    expect(sql).toContain('INSERT INTO "Deck"');
    expect(sql).toContain('INSERT INTO "Card"');
    expect(sql).toContain("COMMIT");
  });

  it("opens source read-only (source is unchanged after dump)", () => {
    const before = readFileSync(srcDb);
    dumpDatabase(srcDb, dumpFile);
    const after = readFileSync(srcDb);
    expect(before.equals(after)).toBe(true);
  });
});

describe("restoreDatabase", () => {
  it("restores tables and rows into a fresh database", () => {
    dumpDatabase(srcDb, dumpFile);
    restoreDatabase(restoreDb, dumpFile, {});

    const db = new Database(restoreDb, { readonly: true });
    const deck = db.prepare("SELECT * FROM Deck WHERE id = ?").get("deck1") as {
      name: string;
    };
    const card = db.prepare("SELECT * FROM Card WHERE id = ?").get("card1") as {
      front: string;
      back: string;
      tags: string;
      stability: number;
    };
    db.close();

    expect(deck.name).toBe("TestDeck");
    expect(card.front).toBe("What's a \"quote\" and 'apostrophe'?\nNewline here");
    expect(card.back).toBe("Answer with\ttab");
    expect(card.tags).toBe("foo,bar");
    expect(card.stability).toBe(1.5);
  });

  it("refuses to overwrite an existing file without force", () => {
    dumpDatabase(srcDb, dumpFile);
    restoreDatabase(restoreDb, dumpFile, {});
    expect(() => restoreDatabase(restoreDb, dumpFile, {})).toThrow(/overwrite/i);
    expect(existsSync(restoreDb)).toBe(true);
  });

  it("overwrites when force=true", () => {
    dumpDatabase(srcDb, dumpFile);
    restoreDatabase(restoreDb, dumpFile, {});
    expect(() => restoreDatabase(restoreDb, dumpFile, { force: true })).not.toThrow();
  });
});
