import { describe, it, expect, beforeEach } from "vitest";
import {
  WARN_FLASHCARDS,
  PAUSE_FLASHCARDS,
  WARN_NEW_TODAY,
  PAUSE_NEW_TODAY,
  checkPressure,
  assertCanCreateCard,
} from "../../src/core/pressure.js";
import { createCard, updateCard } from "../../src/core/card-service.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";
import { State } from "ts-fsrs";

let testDeckId: string;

const pastDue = () => new Date(Date.now() - 60_000);
const futureDue = () => new Date(Date.now() + 24 * 3600 * 1000);
const yesterday = () => new Date(Date.now() - 24 * 3600 * 1000);

async function seedCards(
  n: number,
  data: {
    state?: number;
    due?: Date;
    createdAt?: Date;
    suspended?: boolean;
    lastReview?: Date;
  } = {}
): Promise<void> {
  const db = getDb();
  await db.card.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      deckId: testDeckId,
      front: `seed ${Math.random()} ${i}`,
      back: "a",
      state: data.state ?? State.Review,
      due: data.due ?? pastDue(),
      createdAt: data.createdAt ?? yesterday(),
      suspended: data.suspended ?? false,
      lastReview: data.lastReview ?? null,
    })),
  });
}

/** A parent card that already carries review history, as a real split source would. */
async function seedReviewedParent(): Promise<string> {
  const db = getDb();
  const parent = await db.card.create({
    data: {
      deckId: testDeckId,
      front: `parent ${Math.random()}`,
      back: "a",
      state: State.Review,
      due: futureDue(),
      createdAt: yesterday(),
      lastReview: yesterday(),
      reps: 4,
      stability: 30,
    },
  });
  return parent.id;
}

describe("pressure", () => {
  beforeEach(async () => {
    const deck = await createDeck("PressureDeck");
    testDeckId = deck.id;
  });

  describe("review backlog counting", () => {
    it("counts only due, unsuspended, non-new cards", async () => {
      await seedCards(3);
      await seedCards(2, { state: State.New });
      await seedCards(1, { suspended: true });
      await seedCards(1, { due: futureDue() });

      expect((await checkPressure()).flashcardsDue).toBe(3);
    });

    it("counts Learning and Relearning states, not just Review", async () => {
      await seedCards(2, { state: State.Learning });
      await seedCards(3, { state: State.Relearning });
      await seedCards(1, { state: State.Review });

      expect((await checkPressure()).flashcardsDue).toBe(6);
    });
  });

  describe("intake counting (cards added today)", () => {
    it("counts a fresh card created today, ignores earlier days", async () => {
      await seedCards(2, { createdAt: new Date() });
      await seedCards(3, { createdAt: yesterday() });

      expect((await checkPressure()).newToday).toBe(2);
    });

    it("does not count a split created today off a reviewed parent", async () => {
      const parentId = await seedReviewedParent();

      await createCard({ deckId: testDeckId, front: "split", back: "a", inheritFrom: parentId });

      expect((await checkPressure()).newToday).toBe(0);
    });

    it("does not count a split off a parent reviewed earlier today", async () => {
      const db = getDb();
      const parent = await db.card.create({
        data: {
          deckId: testDeckId,
          front: "reviewed today",
          back: "a",
          state: State.Review,
          due: futureDue(),
          createdAt: yesterday(),
          lastReview: new Date(),
          reps: 2,
        },
      });

      await createCard({ deckId: testDeckId, front: "split", back: "a", inheritFrom: parent.id });

      expect((await checkPressure()).newToday).toBe(0);
    });

    it("does not count a split even after the split itself is reviewed today", async () => {
      const db = getDb();
      const parentId = await seedReviewedParent();
      const { card: split } = await createCard({
        deckId: testDeckId,
        front: "split",
        back: "a",
        inheritFrom: parentId,
      });

      // The old lastReview/createdAt heuristic flipped this row into "intake"
      // the moment it was studied; the explicit column does not.
      await db.card.update({
        where: { id: split.id },
        data: { lastReview: new Date(), reps: { increment: 1 } },
      });

      expect((await checkPressure()).newToday).toBe(0);
    });

    it("does not count a split off a never-reviewed parent", async () => {
      const { card: parent } = await createCard({
        deckId: testDeckId,
        front: "fresh parent",
        back: "a",
      });

      await createCard({ deckId: testDeckId, front: "split", back: "a", inheritFrom: parent.id });

      expect((await checkPressure()).newToday).toBe(1);
    });

    it("counts a fresh card created today and reviewed today", async () => {
      await seedCards(1, { createdAt: new Date(), lastReview: new Date() });

      expect((await checkPressure()).newToday).toBe(1);
    });

    it("does not count a card created yesterday, reviewed or not", async () => {
      await seedCards(1, { createdAt: yesterday() });
      await seedCards(1, { createdAt: yesterday(), lastReview: new Date() });

      expect((await checkPressure()).newToday).toBe(0);
    });

    it("counts suspended cards: suspending must not be a way to dodge the intake gate", async () => {
      await seedCards(3, { createdAt: new Date(), suspended: true });

      expect((await checkPressure()).newToday).toBe(3);
    });
  });

  describe("newAvailable reporting", () => {
    it("counts due unsuspended new cards only", async () => {
      await seedCards(2, { state: State.New });
      await seedCards(1, { state: State.New, suspended: true });
      await seedCards(1, { state: State.New, due: futureDue() });
      await seedCards(1, { state: State.Review });

      expect((await checkPressure()).newAvailable).toBe(2);
    });
  });

  describe("checkPressure verdict: flashcards axis", () => {
    it("reads ok below the warn threshold", async () => {
      await seedCards(WARN_FLASHCARDS - 1);
      const p = await checkPressure();
      expect(p.verdict).toBe("ok");
      expect(p.flashcardsDue).toBe(19);
      expect(p.reasons).toEqual([]);
    });

    it("reads warn at the warn threshold", async () => {
      await seedCards(WARN_FLASHCARDS);
      const p = await checkPressure();
      expect(p.verdict).toBe("warn");
      expect(p.reasons).toEqual(["20 flashcards due"]);
    });

    it("reads pause at the pause threshold", async () => {
      await seedCards(PAUSE_FLASHCARDS);
      const p = await checkPressure();
      expect(p.verdict).toBe("pause");
      expect(p.reasons).toEqual(["50 flashcards due (>= 50)"]);
    });
  });

  describe("checkPressure verdict: cards-added-today axis", () => {
    it("reads ok below the warn threshold", async () => {
      await seedCards(WARN_NEW_TODAY - 1, { state: State.New, createdAt: new Date() });
      const p = await checkPressure();
      expect(p.verdict).toBe("ok");
      expect(p.newToday).toBe(4);
    });

    it("reads warn at the warn threshold", async () => {
      await seedCards(WARN_NEW_TODAY, { state: State.New, createdAt: new Date() });
      const p = await checkPressure();
      expect(p.verdict).toBe("warn");
      expect(p.reasons).toEqual(["5 cards added today"]);
    });

    it("reads pause at the pause threshold", async () => {
      await seedCards(PAUSE_NEW_TODAY, { state: State.New, createdAt: new Date() });
      const p = await checkPressure();
      expect(p.verdict).toBe("pause");
      expect(p.reasons).toEqual(["10 cards added today (>= 10)"]);
    });
  });

  describe("checkPressure combined axes", () => {
    it("warn on both axes reads warn with two reasons", async () => {
      await seedCards(WARN_FLASHCARDS);
      await seedCards(WARN_NEW_TODAY, { state: State.New, createdAt: new Date() });
      const p = await checkPressure();
      expect(p.verdict).toBe("warn");
      expect(p.reasons).toEqual(["20 flashcards due", "5 cards added today"]);
    });

    it("pause on one axis beats warn on the other", async () => {
      await seedCards(WARN_FLASHCARDS);
      await seedCards(PAUSE_NEW_TODAY, { state: State.New, createdAt: new Date() });
      const p = await checkPressure();
      expect(p.verdict).toBe("pause");
      expect(p.reasons).toEqual(["20 flashcards due", "10 cards added today (>= 10)"]);
    });

    it("all-new due deck reads ok: new cards are an optional pool, not backlog", async () => {
      await seedCards(22, { state: State.New });
      const p = await checkPressure();
      expect(p.verdict).toBe("ok");
      expect(p.flashcardsDue).toBe(0);
      expect(p.newAvailable).toBe(22);
      expect(p.newToday).toBe(0);
      expect(p.reasons).toEqual([]);
    });
  });

  describe("checkPressure report shape", () => {
    it("echoes the thresholds", async () => {
      const p = await checkPressure();
      expect(p.thresholds).toEqual({
        flashcards: { warn: WARN_FLASHCARDS, pause: PAUSE_FLASHCARDS },
        newToday: { warn: WARN_NEW_TODAY, pause: PAUSE_NEW_TODAY },
      });
    });

    it("computes clearance for the flashcards axis only", async () => {
      await seedCards(60);
      const p = await checkPressure();
      expect(p.clearance).toEqual({
        flashcards: { due: 60, toExitWarn: 41, toExitPause: 11 },
      });
    });

    it("clearance is zero when below the thresholds", async () => {
      await seedCards(5);
      const p = await checkPressure();
      expect(p.clearance.flashcards.toExitWarn).toBe(0);
      expect(p.clearance.flashcards.toExitPause).toBe(0);
    });

    it("includes per-deck stats", async () => {
      const db = getDb();
      const deck2 = await db.deck.create({ data: { name: "OtherDeck" } });
      await seedCards(3);
      await db.card.create({
        data: { deckId: deck2.id, front: "other", back: "a", state: State.Review, due: pastDue() },
      });

      const p = await checkPressure();
      expect(p.decks.length).toBe(2);
      const pressureDeck = p.decks.find((d) => d.name === "PressureDeck");
      const otherDeck = p.decks.find((d) => d.name === "OtherDeck");
      expect(pressureDeck?.dueCards).toBe(3);
      expect(otherDeck?.dueCards).toBe(1);
    });
  });

  describe("assertCanCreateCard", () => {
    it("resolves at warn", async () => {
      await seedCards(22);
      await expect(assertCanCreateCard()).resolves.toBeUndefined();
    });

    it("throws at pause with counts, thresholds, and clearance", async () => {
      await seedCards(60);
      await expect(assertCanCreateCard()).rejects.toThrow(
        /60 flashcards due \(pause at 50\): review 11/
      );
      await expect(assertCanCreateCard()).rejects.toThrow(/inheritFrom/);
    });

    it("throws at pause on the cards-added-today axis", async () => {
      await seedCards(PAUSE_NEW_TODAY, { state: State.New, createdAt: new Date() });
      await expect(assertCanCreateCard()).rejects.toThrow(
        /10 cards added today \(pause at 10\)/
      );
    });
  });

  describe("create gate wiring", () => {
    it("createCard throws at backlog pause", async () => {
      await seedCards(PAUSE_FLASHCARDS);
      await expect(
        createCard({ deckId: testDeckId, front: "one more", back: "a" })
      ).rejects.toThrow(/Card creation blocked/);
    });

    it("createCard throws at intake pause", async () => {
      await seedCards(PAUSE_NEW_TODAY, { state: State.New, createdAt: new Date() });
      await expect(
        createCard({ deckId: testDeckId, front: "one more", back: "a" })
      ).rejects.toThrow(/10 cards added today/);
    });

    it("createCard with inheritFrom succeeds at pause and records provenance", async () => {
      await seedCards(PAUSE_FLASHCARDS);
      const parent = await getDb().card.findFirst();
      const { card } = await createCard({
        deckId: testDeckId,
        front: "split",
        back: "a",
        inheritFrom: parent!.id,
      });
      expect(card.front).toBe("split");
      expect(card.inheritedFrom).toBe(parent!.id);
    });

    it("a fresh card records no provenance", async () => {
      const { card } = await createCard({ deckId: testDeckId, front: "fresh", back: "a" });
      expect(card.inheritedFrom).toBeNull();
    });

    it("updateCard succeeds at pause", async () => {
      await seedCards(PAUSE_FLASHCARDS);
      const existing = await getDb().card.findFirst();
      const updated = await updateCard(existing!.id, { front: "edited under pressure" });
      expect(updated.front).toBe("edited under pressure");
    });
  });
});
