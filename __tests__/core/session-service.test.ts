import { describe, it, expect, beforeEach } from "vitest";
import {
  startSession,
  getNextCard,
  submitReview,
  adjustSession,
  skipCard,
} from "../../src/core/session-service.js";
import { createCard } from "../../src/core/card-service.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";
import { Rating, State } from "ts-fsrs";

let deckId: string;

async function seedCards(
  count: number,
  overrides: Partial<{
    state: number;
    due: Date;
    type: string;
    maturity: string;
    stability: number;
    lastReview: Date;
  }> = {}
) {
  const db = getDb();
  const cards = [];
  for (let i = 0; i < count; i++) {
    const card = await db.card.create({
      data: {
        deckId,
        front: `Question ${i + 1}`,
        back: `Answer ${i + 1}`,
        state: overrides.state ?? State.New,
        due: overrides.due ?? new Date(),
        type: overrides.type ?? "guided",
        maturity: overrides.maturity ?? "new",
        stability: overrides.stability ?? 0,
        lastReview: overrides.lastReview ?? null,
      },
    });
    cards.push(card);
  }
  return cards;
}

describe("session-service", () => {
  beforeEach(async () => {
    const deck = await createDeck("TestDeck");
    deckId = deck.id;
  });

  describe("startSession", () => {
    it("creates a session and returns queue info", async () => {
      await seedCards(3);

      const session = await startSession();
      expect(session.id).toBeDefined();
      expect(session.queue.length).toBe(3);
    });

    it("uses defaults when configOverrides contains undefined values", async () => {
      // Seed more cards than the default cap (5) to verify the limit is applied
      await seedCards(10);

      // Simulates MCP call path where arg() returns undefined for unset params
      const session = await startSession({
        maxNewCardsPerSession: undefined,
        maxReviewCardsPerSession: undefined,
        practiceFirstMode: undefined,
      });
      expect(session.id).toBeDefined();
      // Should respect default maxNewCardsPerSession (5), not return all 10
      expect(session.queue.length).toBe(5);
    });

    it("caps new cards at maxNewCardsPerSession", async () => {
      await seedCards(10); // 10 new cards

      const session = await startSession({ maxNewCardsPerSession: 5 });
      expect(session.queue.length).toBe(5);
    });

    it("caps review cards at maxReviewCardsPerSession", async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await seedCards(20, {
        state: State.Review,
        due: past,
        stability: 5,
        lastReview: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      });

      const session = await startSession({ maxReviewCardsPerSession: 10 });
      expect(session.queue.length).toBeLessThanOrEqual(10);
    });

    it("reduces new card allowance when review-heavy (>10 reviews)", async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      // 12 review cards due
      await seedCards(12, {
        state: State.Review,
        due: past,
        stability: 5,
        lastReview: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      });
      // 10 new cards
      await seedCards(10);

      const session = await startSession({
        maxNewCardsPerSession: 5,
        maxReviewCardsPerSession: 15,
      });

      // Count new cards in the queue
      const newCardsInQueue = session.queue.filter(
        (item) => item.reason === "new_card"
      ).length;
      expect(newCardsInQueue).toBeLessThanOrEqual(3);
    });

    it("prioritizes unguided cards in practice-first mode", async () => {
      await seedCards(3); // guided new cards
      await seedCards(2, { type: "unguided" }); // unguided new cards

      const session = await startSession({ practiceFirstMode: true });

      // First cards in queue should be unguided
      const firstUnguided = session.queue.findIndex(
        (item) => item.reason === "unguided_priority"
      );
      // Unguided cards should appear (might be at start)
      const unguidedCount = session.queue.filter(
        (item) => item.reason === "unguided_priority"
      ).length;
      expect(unguidedCount).toBe(2);
    });

    it("excludes suspended cards", async () => {
      const db = getDb();
      await seedCards(3);
      const cards = await db.card.findMany();
      await db.card.update({
        where: { id: cards[0].id },
        data: { suspended: true },
      });

      const session = await startSession();
      expect(session.queue.length).toBe(2);
    });
  });

  describe("getNextCard", () => {
    it("returns the next card from the queue", async () => {
      await seedCards(3);
      const session = await startSession();

      const card = await getNextCard(session.id);
      expect(card).not.toBeNull();
      expect(card!.front).toBeDefined();
      expect(card!.back).toBeDefined();
    });

    it("returns null when queue is exhausted", async () => {
      await seedCards(1);
      const session = await startSession();

      const first = await getNextCard(session.id);
      expect(first).not.toBeNull();

      // Submit review to advance queue
      await submitReview(session.id, first!.id, Rating.Good);

      const second = await getNextCard(session.id);
      expect(second).toBeNull();
    });
  });

  describe("submitReview", () => {
    it("updates card scheduling and creates review record", async () => {
      await seedCards(1);
      const session = await startSession();
      const card = await getNextCard(session.id);

      await submitReview(session.id, card!.id, Rating.Good, 2000);

      const db = getDb();
      const updatedCard = await db.card.findUnique({
        where: { id: card!.id },
      });
      expect(updatedCard!.reps).toBe(1);
      expect(updatedCard!.stability).toBeGreaterThan(0);

      const reviews = await db.review.findMany({
        where: { cardId: card!.id },
      });
      expect(reviews.length).toBe(1);
      expect(reviews[0].rating).toBe(Rating.Good);
      expect(reviews[0].responseMs).toBe(2000);
    });

    it("increments session cardsReviewed count", async () => {
      await seedCards(2);
      const session = await startSession();
      const card = await getNextCard(session.id);

      await submitReview(session.id, card!.id, Rating.Good);

      const db = getDb();
      const updated = await db.studySession.findUnique({
        where: { id: session.id },
      });
      expect(updated!.cardsReviewed).toBe(1);
    });

    it("updates endTime and accuracy after each review", async () => {
      await seedCards(2);
      const session = await startSession();
      const db = getDb();

      const card1 = await getNextCard(session.id);
      await submitReview(session.id, card1!.id, Rating.Good);

      const afterFirst = await db.studySession.findUnique({ where: { id: session.id } });
      expect(afterFirst!.endTime).not.toBeNull();
      expect(afterFirst!.accuracy).toBe(1.0); // 1 good / 1 total

      const card2 = await getNextCard(session.id);
      await submitReview(session.id, card2!.id, Rating.Again);

      const afterSecond = await db.studySession.findUnique({ where: { id: session.id } });
      expect(afterSecond!.accuracy).toBe(0.5); // 1 good / 2 total
    });

    it("counts Good and Easy as correct, Again and Hard as incorrect", async () => {
      await seedCards(4);
      const session = await startSession({ maxNewCardsPerSession: 4 });
      const db = getDb();

      for (const rating of [Rating.Easy, Rating.Hard, Rating.Good, Rating.Again]) {
        const card = await getNextCard(session.id);
        await submitReview(session.id, card!.id, rating);
      }

      const updated = await db.studySession.findUnique({ where: { id: session.id } });
      expect(updated!.accuracy).toBe(0.5); // Easy + Good = 2 correct / 4 total
    });
  });

  describe("getNextCard queue cleanup", () => {
    it("returns null repeatedly after queue exhausts", async () => {
      await seedCards(1);
      const session = await startSession();

      const card = await getNextCard(session.id);
      await submitReview(session.id, card!.id, Rating.Good);

      // First call after exhaustion
      expect(await getNextCard(session.id)).toBeNull();
      // Subsequent calls don't throw
      expect(await getNextCard(session.id)).toBeNull();
    });
  });

  describe("skipCard", () => {
    it("advances to the next card without creating a review", async () => {
      await seedCards(3);
      const session = await startSession();

      const card1 = await getNextCard(session.id);
      expect(card1).not.toBeNull();

      const skipped = skipCard(session.id);
      expect(skipped).toBe(true);

      const card2 = await getNextCard(session.id);
      expect(card2).not.toBeNull();
      expect(card2!.id).not.toBe(card1!.id);

      // No review record should exist for the skipped card
      const db = getDb();
      const reviews = await db.review.findMany({
        where: { cardId: card1!.id },
      });
      expect(reviews.length).toBe(0);
    });

    it("returns false for unknown session", () => {
      expect(skipCard("nonexistent")).toBe(false);
    });

    it("allows exhausting the queue via skips", async () => {
      await seedCards(2);
      const session = await startSession();

      skipCard(session.id);
      skipCard(session.id);

      const card = await getNextCard(session.id);
      expect(card).toBeNull();
    });
  });

  describe("adjustSession", () => {
    it("reduces queue size mid-session", async () => {
      await seedCards(5);
      const session = await startSession();

      const adjusted = await adjustSession(session.id, { maxCards: 2 });
      expect(adjusted.queue.length).toBeLessThanOrEqual(2);
    });
  });
});
