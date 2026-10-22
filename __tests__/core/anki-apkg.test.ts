import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import {
  exportToApkg,
  exportCardsToApkg,
  readApkg,
  importApkgFile,
  isApkgPath,
  convertSM2toFSRS,
  convertFSRStoSM2,
} from "../../src/core/anki-apkg.js";
import { createDeck } from "../../src/core/deck-service.js";
import { createCard, suspendCard } from "../../src/core/card-service.js";
import { getDb } from "../../src/db/client.js";
import { State, Rating } from "ts-fsrs";
import { submitReview, startSession, getNextCard } from "../../src/core/session-service.js";

let deckId: string;
let tempDir: string;

const DAY_MS = 86_400_000;

/** A card as Anki stores it, for packages built by hand. */
interface AnkiCard {
  front: string;
  type: number;
  queue: number;
  due: number;
  ivl?: number;
  factor?: number;
  reps?: number;
  lapses?: number;
  data?: string;
  /** [revlog id (ms), ease] per review. */
  revlog?: Array<[number, number]>;
}

/** Write a minimal Anki 2.1 package (schema v11) holding one deck. */
function writeAnkiPackage(path: string, crt: number, cards: AnkiCard[]): void {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE col (crt integer, decks text);
    CREATE TABLE notes (id integer PRIMARY KEY, tags text, flds text);
    CREATE TABLE cards (id integer PRIMARY KEY, nid integer, did integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, data text);
    CREATE TABLE revlog (id integer PRIMARY KEY, cid integer, ease integer, time integer);
  `);
  db.prepare("INSERT INTO col VALUES (?, ?)").run(crt, JSON.stringify({ "7": { id: 7, name: "Anki" } }));
  cards.forEach((c, i) => {
    const id = i + 1;
    db.prepare("INSERT INTO notes VALUES (?, '', ?)").run(id, `${c.front}\x1fAnswer ${id}`);
    db.prepare("INSERT INTO cards VALUES (?, ?, 7, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, id, c.type, c.queue, c.due, c.ivl ?? 0, c.factor ?? 0, c.reps ?? 0, c.lapses ?? 0, c.data ?? ""
    );
    for (const [revId, ease] of c.revlog ?? []) {
      db.prepare("INSERT INTO revlog VALUES (?, ?, ?, 1000)").run(revId, id, ease);
    }
  });
  const zip = new AdmZip();
  zip.addFile("collection.anki21", Buffer.from(db.serialize()));
  db.close();
  zip.writeZip(path);
}

describe("anki-apkg", () => {
  beforeEach(async () => {
    const deck = await createDeck("React");
    deckId = deck.id;
    tempDir = mkdtempSync(join(tmpdir(), "apkg-test-"));
  });

  it("isApkgPath accepts deck and collection packages only", () => {
    expect(isApkgPath("a.apkg")).toBe(true);
    expect(isApkgPath("a.COLPKG")).toBe(true);
    expect(isApkgPath("a.txt")).toBe(false);
  });

  describe("convertSM2toFSRS", () => {
    it("takes stability from the interval and difficulty from the ease", () => {
      const result = convertSM2toFSRS({ ivl: 30, factor: 2500, reps: 10 });

      expect(result.stability).toBe(30);
      expect(result.difficulty).toBeGreaterThan(0);
      expect(result.difficulty).toBeLessThan(10);
    });

    it("gives a new card no stability and middling difficulty", () => {
      expect(convertSM2toFSRS({ ivl: 0, factor: 0, reps: 0 })).toEqual({ stability: 0, difficulty: 5 });
    });

    it("gives a seen learning card a small positive stability", () => {
      expect(convertSM2toFSRS({ ivl: 0, factor: 0, reps: 2 }).stability).toBe(1);
    });

    it("clamps difficulty to valid range", () => {
      expect(convertSM2toFSRS({ ivl: 30, factor: 5000, reps: 5 }).difficulty).toBeGreaterThanOrEqual(1);
      expect(convertSM2toFSRS({ ivl: 30, factor: 1300, reps: 5 }).difficulty).toBeLessThanOrEqual(10);
    });
  });

  describe("convertFSRStoSM2", () => {
    it("converts FSRS fields to SM-2 equivalents", () => {
      const result = convertFSRStoSM2({
        difficulty: 5,
        state: State.Review,
        due: new Date("2026-04-15"),
        interval: 30,
        suspended: false,
      });

      expect(result.ivl).toBe(30);
      expect(result.factor).toBeGreaterThan(1000);
      expect(result.factor).toBeLessThanOrEqual(5000);
      expect(result.type).toBe(2); // review
      expect(result.queue).toBe(2);
    });

    it("converts new card state", () => {
      const result = convertFSRStoSM2({
        difficulty: 0,
        state: State.New,
        due: new Date(),
        interval: 0,
        suspended: false,
      });

      expect(result.type).toBe(0);
      expect(result.queue).toBe(0);
      expect(result.factor).toBe(0);
    });

    it("writes relearning cards to the intraday queue, due in epoch seconds", () => {
      const due = new Date("2026-04-15T10:00:00Z");
      const result = convertFSRStoSM2({ difficulty: 5, state: State.Relearning, due, interval: 0, suspended: false });

      expect(result.type).toBe(3);
      expect(result.queue).toBe(1);
      expect(result.due).toBe(due.getTime() / 1000);
    });

    it("puts suspended cards in Anki's suspended queue", () => {
      const result = convertFSRStoSM2({ difficulty: 5, state: State.Review, due: new Date(), interval: 3, suspended: true });
      expect(result.type).toBe(2);
      expect(result.queue).toBe(-1);
    });
  });

  describe("exportCardsToApkg", () => {
    it("writes a ZIP with every deck that has cards", async () => {
      const deck2 = await createDeck("TypeScript");
      await createDeck("Empty");
      await createCard({ deckId, front: "Q1", back: "A1" });
      await createCard({ deckId: deck2.id, front: "Q2", back: "A2" });

      const outPath = join(tempDir, "multi.apkg");
      const result = await exportCardsToApkg(outPath);

      expect(result).toEqual({ cardCount: 2, deckCount: 2 });
      const buf = readFileSync(outPath);
      expect(buf[0]).toBe(0x50); // ZIP magic: PK
      expect(buf[1]).toBe(0x4b);
      expect(readApkg(outPath).map((d) => d.name).sort()).toEqual(["React", "TypeScript"]);
    });

    it("exports only the given deck", async () => {
      const deck2 = await createDeck("TypeScript");
      await createCard({ deckId, front: "Q1", back: "A1" });
      await createCard({ deckId: deck2.id, front: "Q2", back: "A2" });

      const outPath = join(tempDir, "one.apkg");
      expect(await exportCardsToApkg(outPath, deck2.id)).toEqual({ cardCount: 1, deckCount: 1 });
      expect(readApkg(outPath)[0].items.map((c) => c.front)).toEqual(["Q2"]);
    });

    it("writes two reviews in the same millisecond without a revlog id clash", async () => {
      const outPath = join(tempDir, "same-ms.apkg");
      const reviewedAt = new Date("2026-01-01T00:00:00Z");
      const review = { rating: Rating.Good, reviewedAt, responseMs: 1000, stability: 3, difficulty: 5 };
      await exportToApkg(outPath, [{
        deckName: "React",
        cards: [{
          id: "same-ms",
          front: "Q",
          back: "A",
          tags: [],
          schedule: {
            stability: 3, difficulty: 5, state: State.Review, reps: 2, lapses: 0,
            due: new Date(), interval: 3, lastReview: reviewedAt, suspended: false,
          },
          reviews: [review, review],
        }],
      }]);

      const reviews = readApkg(outPath)[0].items[0].reviews;
      expect(reviews.map((r) => r.reviewedAt.getTime())).toEqual([reviewedAt.getTime(), reviewedAt.getTime() + 1]);
    });
  });

  describe("round trip", () => {
    it("restores cards, schedules, suspension and history into an empty database", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "A syntax extension", tags: ["react"] });
      const { card: kept } = await createCard({ deckId, front: "What is useState?", back: "A React hook" });
      const session = await startSession();
      const served = await getNextCard(session.id);
      await submitReview(session.id, served!.id, Rating.Good, 1500);
      await suspendCard(kept.id);
      const before = await getDb().card.findMany({ orderBy: { front: "asc" } });

      const outPath = join(tempDir, "roundtrip.apkg");
      await exportCardsToApkg(outPath);
      await getDb().card.deleteMany();

      const result = await importApkgFile(outPath);

      expect(result).toEqual({ created: 2, updated: 0, duplicates: 0, invalid: 0 });
      const after = await getDb().card.findMany({ orderBy: { front: "asc" }, include: { reviews: true } });
      expect(after.map((c) => [c.front, c.back, c.tags, c.state, c.reps, c.lapses, c.suspended])).toEqual(
        before.map((c) => [c.front, c.back, c.tags, c.state, c.reps, c.lapses, c.suspended])
      );
      const reviewed = after.find((c) => c.reviews.length > 0);
      expect(reviewed?.reviews.map((r) => r.rating)).toEqual([Rating.Good]);
      expect(reviewed?.stability).toBeGreaterThan(0);
    });
  });

  describe("readApkg", () => {
    const crt = Math.floor(new Date("2024-01-01T00:00:00Z").getTime() / 1000);

    it("dates interday (re)learning cards from the collection's creation", () => {
      const path = join(tempDir, "interday.apkg");
      writeAnkiPackage(path, crt, [{ front: "Q", type: 3, queue: 3, due: 10, ivl: 1, factor: 2500, reps: 4, lapses: 1 }]);

      const card = readApkg(path)[0].items[0];
      expect(card.schedule.state).toBe(State.Relearning);
      expect(card.schedule.due.toISOString()).toBe("2024-01-11T00:00:00.000Z");
    });

    it("reads intraday learning due dates as epoch seconds", () => {
      const path = join(tempDir, "intraday.apkg");
      const dueSeconds = Math.floor(new Date("2026-05-01T12:00:00Z").getTime() / 1000);
      writeAnkiPackage(path, crt, [{ front: "Q", type: 1, queue: 1, due: dueSeconds, reps: 1 }]);

      expect(readApkg(path)[0].items[0].schedule.due.toISOString()).toBe("2026-05-01T12:00:00.000Z");
    });

    it("carries suspension (queue -1)", () => {
      const path = join(tempDir, "suspended.apkg");
      writeAnkiPackage(path, crt, [
        { front: "Suspended", type: 2, queue: -1, due: 30, ivl: 10, factor: 2500, reps: 3 },
        { front: "Active", type: 2, queue: 2, due: 30, ivl: 10, factor: 2500, reps: 3 },
      ]);

      expect(readApkg(path)[0].items.map((c) => [c.front, c.schedule.suspended])).toEqual([
        ["Suspended", true],
        ["Active", false],
      ]);
    });

    it("uses native FSRS memory state when the card has it", () => {
      const path = join(tempDir, "fsrs.apkg");
      writeAnkiPackage(path, crt, [
        { front: "Q", type: 2, queue: 2, due: 30, ivl: 10, factor: 2500, reps: 3, data: '{"s":12.5,"d":3.25,"dr":0.9}' },
      ]);

      const { stability, difficulty } = readApkg(path)[0].items[0].schedule;
      expect([stability, difficulty]).toEqual([12.5, 3.25]);
    });

    it("skips manual reschedules in the revlog and dates the last review", () => {
      const path = join(tempDir, "revlog.apkg");
      const first = Date.UTC(2026, 0, 1, 9);
      writeAnkiPackage(path, crt, [{
        front: "Q", type: 2, queue: 2, due: 30, ivl: 3, factor: 2500, reps: 2,
        revlog: [[first, 3], [first + DAY_MS, 0], [first + 3 * DAY_MS, 4]],
      }]);

      const card = readApkg(path)[0].items[0];
      expect(card.reviews.map((r) => r.rating)).toEqual([3, 4]);
      expect(card.schedule.lastReview?.getTime()).toBe(first + 3 * DAY_MS);
    });
  });

  describe("importApkgFile", () => {
    async function makeApkg(front: string, back: string): Promise<string> {
      const outPath = join(tempDir, `${front.slice(0, 8)}.apkg`);
      await exportToApkg(outPath, [{
        deckName: "React",
        cards: [{
          id: "test-id",
          front,
          back,
          tags: [],
          schedule: {
            stability: 0, difficulty: 5, state: State.New, reps: 0, lapses: 0,
            due: new Date(), interval: 0, lastReview: null, suspended: false,
          },
          reviews: [],
        }],
      }]);
      return outPath;
    }

    it("skips duplicates by default (no flag)", async () => {
      const outPath = await makeApkg("What is JSX?", "Imported answer");
      const { card: local } = await createCard({ deckId, front: "What is JSX?", back: "Local answer" });

      const result = await importApkgFile(outPath);

      expect(result).toEqual({ created: 0, updated: 0, duplicates: 1, invalid: 0 });
      const after = await getDb().card.findUniqueOrThrow({ where: { id: local.id } });
      expect(after.back).toBe("Local answer");
    });

    it("overwrites existing card with --theirs, clearing its leech flag", async () => {
      const outPath = await makeApkg("What is JSX?", "Imported answer");
      const { card: local } = await createCard({ deckId, front: "What is JSX?", back: "Local answer" });
      await getDb().card.update({ where: { id: local.id }, data: { lapses: 6, leechFlaggedAt: new Date() } });

      const result = await importApkgFile(outPath, { conflict: "theirs" });

      expect(result).toEqual({ created: 0, updated: 1, duplicates: 0, invalid: 0 });
      const after = await getDb().card.findUniqueOrThrow({ where: { id: local.id } });
      expect(after.back).toBe("Imported answer");
      expect(after.leechFlaggedAt).toBeNull();
      expect(after.lapses).toBe(0);
    });

    it("creates new cards regardless of conflict mode", async () => {
      const outPath = await makeApkg("Brand new card", "Some answer");

      const result = await importApkgFile(outPath, { conflict: "theirs" });

      expect(result).toEqual({ created: 1, updated: 0, duplicates: 0, invalid: 0 });
    });

    it("dry-run with --theirs reports counts but does not update", async () => {
      const outPath = await makeApkg("What is JSX?", "Imported answer");
      const { card: local } = await createCard({ deckId, front: "What is JSX?", back: "Local answer" });

      const result = await importApkgFile(outPath, { conflict: "theirs", dryRun: true });

      expect(result.updated).toBe(1);
      const after = await getDb().card.findUniqueOrThrow({ where: { id: local.id } });
      expect(after.back).toBe("Local answer");
    });

    it("writes history with the days between reviews, so it counts for calibration", async () => {
      const path = join(tempDir, "history.apkg");
      const first = Date.UTC(2026, 0, 1, 9);
      writeAnkiPackage(path, 0, [{
        front: "Q", type: 2, queue: 2, due: 30, ivl: 3, factor: 2500, reps: 2,
        revlog: [[first, 3], [first + 3 * DAY_MS, 3]],
      }]);

      await importApkgFile(path);

      const reviews = await getDb().review.findMany({ orderBy: { reviewedAt: "asc" } });
      expect(reviews.map((r) => r.elapsedDays)).toEqual([0, 3]);
    });

    it("counts cards whose content breaks the card rules as invalid", async () => {
      const path = join(tempDir, "invalid.apkg");
      writeAnkiPackage(path, 0, [
        { front: "Uses **markdown**", type: 0, queue: 0, due: 1 },
        { front: "Fine", type: 0, queue: 0, due: 2 },
      ]);

      const result = await importApkgFile(path);

      expect(result).toEqual({ created: 1, updated: 0, duplicates: 0, invalid: 1 });
    });
  });
});
