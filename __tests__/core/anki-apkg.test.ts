import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  exportToApkg,
  importFromApkg,
  importApkgCards,
  convertSM2toFSRS,
  convertFSRStoSM2,
} from "../../src/core/anki-apkg.js";
import { createDeck } from "../../src/core/deck-service.js";
import { createCard } from "../../src/core/card-service.js";
import { getDb } from "../../src/db/client.js";
import { State, Rating } from "ts-fsrs";
import { submitReview, startSession, getNextCard } from "../../src/core/session-service.js";

let deckId: string;
let tempDir: string;

describe("anki-apkg", () => {
  beforeEach(async () => {
    const deck = await createDeck("React");
    deckId = deck.id;
    tempDir = mkdtempSync(join(tmpdir(), "apkg-test-"));
  });

  describe("convertSM2toFSRS", () => {
    it("converts a review card with typical SM-2 values", () => {
      const result = convertSM2toFSRS({
        ivl: 30,
        factor: 2500,
        type: 2, // review
        reps: 10,
        lapses: 1,
        due: 19500, // days since epoch
      });

      expect(result.stability).toBe(30);
      expect(result.difficulty).toBeGreaterThan(0);
      expect(result.difficulty).toBeLessThan(10);
      expect(result.state).toBe(State.Review);
      expect(result.reps).toBe(10);
      expect(result.lapses).toBe(1);
    });

    it("converts a new card", () => {
      const result = convertSM2toFSRS({
        ivl: 0,
        factor: 0,
        type: 0, // new
        reps: 0,
        lapses: 0,
        due: 0,
      });

      expect(result.state).toBe(State.New);
      expect(result.reps).toBe(0);
    });

    it("converts a learning card", () => {
      const result = convertSM2toFSRS({
        ivl: 0,
        factor: 0,
        type: 1, // learning
        reps: 2,
        lapses: 0,
        due: Math.floor(Date.now() / 1000),
      });

      expect(result.state).toBe(State.Learning);
    });

    it("clamps difficulty to valid range", () => {
      // Very high ease factor
      const easy = convertSM2toFSRS({
        ivl: 30,
        factor: 5000,
        type: 2,
        reps: 5,
        lapses: 0,
        due: 19500,
      });
      expect(easy.difficulty).toBeGreaterThanOrEqual(1);

      // Very low ease factor
      const hard = convertSM2toFSRS({
        ivl: 30,
        factor: 1300,
        type: 2,
        reps: 5,
        lapses: 3,
        due: 19500,
      });
      expect(hard.difficulty).toBeLessThanOrEqual(10);
    });
  });

  describe("convertFSRStoSM2", () => {
    it("converts FSRS fields to SM-2 equivalents", () => {
      const result = convertFSRStoSM2({
        stability: 30,
        difficulty: 5,
        state: State.Review,
        reps: 10,
        lapses: 1,
        due: new Date("2026-04-15"),
        interval: 30,
      });

      expect(result.ivl).toBe(30);
      expect(result.factor).toBeGreaterThan(1000);
      expect(result.factor).toBeLessThanOrEqual(5000);
      expect(result.type).toBe(2); // review
      expect(result.reps).toBe(10);
      expect(result.lapses).toBe(1);
    });

    it("converts new card state", () => {
      const result = convertFSRStoSM2({
        stability: 0,
        difficulty: 0,
        state: State.New,
        reps: 0,
        lapses: 0,
        due: new Date(),
        interval: 0,
      });

      expect(result.type).toBe(0);
      expect(result.queue).toBe(0);
    });
  });

  describe("exportToApkg", () => {
    it("creates a valid .apkg file from cards", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "A syntax extension", tags: ["react"] });
      await createCard({ deckId, front: "What is useState?", back: "A React hook", tags: ["react", "hooks"] });

      const db = getDb();
      const cards = await db.card.findMany({
        include: { deck: true, reviews: true },
      });

      const outPath = join(tempDir, "test.apkg");
      await exportToApkg(outPath, [
        {
          deckName: "React",
          cards: cards.map((c) => ({
            id: c.id,
            front: c.front,
            back: c.back,
            tags: c.tags ? c.tags.split(",").filter(Boolean) : [],
            stability: c.stability,
            difficulty: c.difficulty,
            state: c.state,
            reps: c.reps,
            lapses: c.lapses,
            due: c.due,
            interval: c.interval,
            reviews: c.reviews.map((r) => ({
              rating: r.rating,
              reviewedAt: r.reviewedAt,
              responseMs: r.responseMs ?? 0,
              stability: r.stability,
              difficulty: r.difficulty,
            })),
          })),
        },
      ]);

      // Verify file exists and is a valid ZIP
      const fileBuffer = readFileSync(outPath);
      expect(fileBuffer.length).toBeGreaterThan(0);
      // ZIP magic bytes: PK (50 4B)
      expect(fileBuffer[0]).toBe(0x50);
      expect(fileBuffer[1]).toBe(0x4b);
    });

    it("exports multiple decks", async () => {
      const db = getDb();
      const deck2 = await createDeck("TypeScript");

      await createCard({ deckId, front: "Q1", back: "A1" });
      await createCard({ deckId: deck2.id, front: "Q2", back: "A2" });

      const cardsReact = await db.card.findMany({
        where: { deckId },
        include: { deck: true, reviews: true },
      });
      const cardsTS = await db.card.findMany({
        where: { deckId: deck2.id },
        include: { deck: true, reviews: true },
      });

      const outPath = join(tempDir, "multi.apkg");
      await exportToApkg(outPath, [
        {
          deckName: "React",
          cards: cardsReact.map((c) => ({
            id: c.id,
            front: c.front,
            back: c.back,
            tags: [],
            stability: c.stability,
            difficulty: c.difficulty,
            state: c.state,
            reps: c.reps,
            lapses: c.lapses,
            due: c.due,
            interval: c.interval,
            reviews: [],
          })),
        },
        {
          deckName: "TypeScript",
          cards: cardsTS.map((c) => ({
            id: c.id,
            front: c.front,
            back: c.back,
            tags: [],
            stability: c.stability,
            difficulty: c.difficulty,
            state: c.state,
            reps: c.reps,
            lapses: c.lapses,
            due: c.due,
            interval: c.interval,
            reviews: [],
          })),
        },
      ]);

      const buf = readFileSync(outPath);
      expect(buf[0]).toBe(0x50); // valid ZIP
    });
  });

  describe("importFromApkg", () => {
    it("round-trips export then import preserving deck structure and cards", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "A syntax extension", tags: ["react"] });
      await createCard({ deckId, front: "What is useState?", back: "A React hook", tags: ["hooks"] });

      const db = getDb();
      const cards = await db.card.findMany({
        include: { deck: true, reviews: true },
      });

      const outPath = join(tempDir, "roundtrip.apkg");
      await exportToApkg(outPath, [
        {
          deckName: "React",
          cards: cards.map((c) => ({
            id: c.id,
            front: c.front,
            back: c.back,
            tags: c.tags ? c.tags.split(",").filter(Boolean) : [],
            stability: c.stability,
            difficulty: c.difficulty,
            state: c.state,
            reps: c.reps,
            lapses: c.lapses,
            due: c.due,
            interval: c.interval,
            reviews: [],
          })),
        },
      ]);

      // Import from the exported file
      const imported = await importFromApkg(outPath);

      expect(imported.decks.length).toBe(1);
      expect(imported.decks[0].name).toBe("React");
      expect(imported.decks[0].cards.length).toBe(2);

      const fronts = imported.decks[0].cards.map((c) => c.front).sort();
      expect(fronts).toEqual(["What is JSX?", "What is useState?"]);
    });

    it("preserves scheduling data through round-trip", async () => {
      // Create and review a card to build scheduling state
      await createCard({ deckId, front: "Scheduled Q", back: "Scheduled A" });
      const session = await startSession();
      const card = await getNextCard(session.id);
      await submitReview(session.id, card!.id, Rating.Good, 1500);

      const db = getDb();
      const reviewedCard = await db.card.findUniqueOrThrow({
        where: { id: card!.id },
        include: { deck: true, reviews: true },
      });

      const outPath = join(tempDir, "scheduled.apkg");
      await exportToApkg(outPath, [
        {
          deckName: "React",
          cards: [
            {
              id: reviewedCard.id,
              front: reviewedCard.front,
              back: reviewedCard.back,
              tags: [],
              stability: reviewedCard.stability,
              difficulty: reviewedCard.difficulty,
              state: reviewedCard.state,
              reps: reviewedCard.reps,
              lapses: reviewedCard.lapses,
              due: reviewedCard.due,
              interval: reviewedCard.interval,
              reviews: reviewedCard.reviews.map((r) => ({
                rating: r.rating,
                reviewedAt: r.reviewedAt,
                responseMs: r.responseMs ?? 0,
                stability: r.stability,
                difficulty: r.difficulty,
              })),
            },
          ],
        },
      ]);

      const imported = await importFromApkg(outPath);
      const importedCard = imported.decks[0].cards[0];

      // Scheduling should be preserved
      expect(importedCard.reps).toBe(reviewedCard.reps);
      expect(importedCard.lapses).toBe(reviewedCard.lapses);
      expect(importedCard.stability).toBeGreaterThan(0);
    });

    it("imports review history", async () => {
      await createCard({ deckId, front: "Q", back: "A" });
      const session = await startSession();
      const card = await getNextCard(session.id);
      await submitReview(session.id, card!.id, Rating.Good, 2000);

      const db = getDb();
      const reviewedCard = await db.card.findUniqueOrThrow({
        where: { id: card!.id },
        include: { deck: true, reviews: true },
      });

      const outPath = join(tempDir, "withreviews.apkg");
      await exportToApkg(outPath, [
        {
          deckName: "React",
          cards: [
            {
              id: reviewedCard.id,
              front: reviewedCard.front,
              back: reviewedCard.back,
              tags: [],
              stability: reviewedCard.stability,
              difficulty: reviewedCard.difficulty,
              state: reviewedCard.state,
              reps: reviewedCard.reps,
              lapses: reviewedCard.lapses,
              due: reviewedCard.due,
              interval: reviewedCard.interval,
              reviews: reviewedCard.reviews.map((r) => ({
                rating: r.rating,
                reviewedAt: r.reviewedAt,
                responseMs: r.responseMs ?? 0,
                stability: r.stability,
                difficulty: r.difficulty,
              })),
            },
          ],
        },
      ]);

      const imported = await importFromApkg(outPath);
      expect(imported.decks[0].cards[0].reviews.length).toBe(1);
      expect(imported.decks[0].cards[0].reviews[0].rating).toBe(Rating.Good);
    });
  });

  describe("importApkgCards", () => {
    async function makeApkg(front: string, back: string): Promise<string> {
      const outPath = join(tempDir, `${front.slice(0, 8)}.apkg`);
      await exportToApkg(outPath, [{
        deckName: "React",
        cards: [{ id: "test-id", front, back, tags: [], stability: 0, difficulty: 5, state: 0, reps: 0, lapses: 0, due: new Date(), interval: 0, reviews: [] }],
      }]);
      return outPath;
    }

    it("skips duplicates by default (no flag)", async () => {
      const outPath = await makeApkg("What is JSX?", "Imported answer");
      const { card: local } = await createCard({ deckId, front: "What is JSX?", back: "Local answer" });

      const imported = await importFromApkg(outPath);
      const result = await importApkgCards(imported.decks[0].cards, deckId, {});

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(1);
      const after = await getDb().card.findUniqueOrThrow({ where: { id: local.id } });
      expect(after.back).toBe("Local answer");
    });

    it("skips duplicates with --ours (explicit keep-local)", async () => {
      const outPath = await makeApkg("What is JSX?", "Imported answer");
      const { card: local } = await createCard({ deckId, front: "What is JSX?", back: "Local answer" });

      const imported = await importFromApkg(outPath);
      const result = await importApkgCards(imported.decks[0].cards, deckId, { conflict: "ours" });

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(1);
      const after = await getDb().card.findUniqueOrThrow({ where: { id: local.id } });
      expect(after.back).toBe("Local answer");
    });

    it("overwrites existing card with --theirs", async () => {
      const outPath = await makeApkg("What is JSX?", "Imported answer");
      const { card: local } = await createCard({ deckId, front: "What is JSX?", back: "Local answer" });

      const imported = await importFromApkg(outPath);
      const result = await importApkgCards(imported.decks[0].cards, deckId, { conflict: "theirs" });

      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
      const after = await getDb().card.findUniqueOrThrow({ where: { id: local.id } });
      expect(after.back).toBe("Imported answer");
    });

    it("creates new cards regardless of conflict mode", async () => {
      const outPath = await makeApkg("Brand new card", "Some answer");

      const imported = await importFromApkg(outPath);
      const result = await importApkgCards(imported.decks[0].cards, deckId, { conflict: "theirs" });

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("dry-run with --theirs reports counts but does not update", async () => {
      const outPath = await makeApkg("What is JSX?", "Imported answer");
      const { card: local } = await createCard({ deckId, front: "What is JSX?", back: "Local answer" });

      const imported = await importFromApkg(outPath);
      const result = await importApkgCards(imported.decks[0].cards, deckId, { conflict: "theirs", dryRun: true });

      expect(result.updated).toBe(1);
      const after = await getDb().card.findUniqueOrThrow({ where: { id: local.id } });
      expect(after.back).toBe("Local answer");
    });
  });
});
