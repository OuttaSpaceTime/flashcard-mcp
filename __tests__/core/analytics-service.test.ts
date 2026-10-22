import { describe, it, expect } from "vitest";
import {
  getStudyStreak,
  getRetentionByDeck,
  getMaturityReport,
  getLapsePatterns,
  getSessionHistory,
} from "../../src/core/analytics-service.js";
import { getDb } from "../../src/db/client.js";
import { State } from "ts-fsrs";

/** A review at each of `dates`, on one card. */
async function reviewsAt(...dates: Date[]): Promise<void> {
  const db = getDb();
  const deck = await db.deck.create({ data: { name: `Streak ${Math.random()}` } });
  const card = await db.card.create({ data: { deckId: deck.id, front: "Q", back: "A" } });
  for (const reviewedAt of dates) {
    await db.review.create({
      data: { cardId: card.id, rating: 3, stability: 1, difficulty: 5, elapsedDays: 0, reviewedAt },
    });
  }
}

describe("analytics-service", () => {
  describe("getStudyStreak", () => {
    // Local noon, `daysBack` local days before today.
    function daysAgo(daysBack: number): Date {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, 12);
    }
    const NOW = daysAgo(0);

    it("returns 0 when nothing was reviewed", async () => {
      expect(await getStudyStreak(NOW)).toBe(0);
    });

    // A study day is a local calendar day: a review just after local
    // midnight belongs to today even where that instant is yesterday in UTC.
    it("counts a review just after local midnight as today", async () => {
      const justAfterMidnight = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 0, 30);
      await reviewsAt(justAfterMidnight);
      expect(await getStudyStreak(NOW)).toBe(1);
    });

    it("counts consecutive days", async () => {
      await reviewsAt(daysAgo(0), daysAgo(1), daysAgo(2));
      expect(await getStudyStreak(NOW)).toBe(3);
    });

    it("breaks streak on gap day", async () => {
      await reviewsAt(daysAgo(0), daysAgo(2));
      expect(await getStudyStreak(NOW)).toBe(1);
    });

    // A session started before midnight whose reviews run past it studied on
    // both days; counting by session start credited only the first.
    it("credits each day a session's reviews fall on", async () => {
      const yesterdayLate = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 23, 50);
      const todayEarly = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 0, 10);
      await getDb().studySession.create({ data: { startTime: yesterdayLate, cardsReviewed: 2 } });
      await reviewsAt(yesterdayLate, todayEarly);
      expect(await getStudyStreak(NOW)).toBe(2);
    });

    it("follows a streak longer than the first window it reads", async () => {
      await reviewsAt(...Array.from({ length: 40 }, (_, i) => daysAgo(i)));
      expect(await getStudyStreak(NOW)).toBe(40);
    });
  });

  describe("getRetentionByDeck", () => {
    it("returns retention data per deck", async () => {
      const db = getDb();
      const deck = await db.deck.create({ data: { name: "React" } });
      const lastReview = new Date();
      await db.card.create({
        data: {
          deckId: deck.id,
          front: "Q",
          back: "A",
          state: State.Review,
          stability: 10,
          lastReview,
          due: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        },
      });

      const retention = await getRetentionByDeck();
      expect(retention.length).toBe(1);
      expect(retention[0].deckName).toBe("React");
      expect(retention[0].avgRetention).toBeGreaterThan(0);
    });
  });

  describe("getMaturityReport", () => {
    it("derives maturity from state and interval, not a stored field", async () => {
      const db = getDb();
      const deck = await db.deck.create({ data: { name: "React" } });
      await db.card.create({
        data: { deckId: deck.id, front: "Q1", back: "A1", state: 0, interval: 0 },
      });
      await db.card.create({
        data: { deckId: deck.id, front: "Q2", back: "A2", state: 2, interval: 10 },
      });
      await db.card.create({
        data: { deckId: deck.id, front: "Q3", back: "A3", state: 2, interval: 200 },
      });

      const report = await getMaturityReport();
      expect(report.length).toBe(1);
      expect(report[0].deckName).toBe("React");
      expect(report[0].new).toBe(1);
      expect(report[0].familiar).toBe(1);
      expect(report[0].internalized).toBe(1);
      expect(report[0].total).toBe(3);
    });

    it("counts a heavily reviewed card as internalized, not new", async () => {
      const db = getDb();
      const deck = await db.deck.create({ data: { name: "Security" } });
      await db.card.create({
        data: {
          deckId: deck.id,
          front: "Q",
          back: "A",
          state: 2,
          interval: 300,
          reps: 38,
          stability: 2229,
        },
      });

      const report = await getMaturityReport();
      expect(report[0].internalized).toBe(1);
      expect(report[0].new).toBe(0);
    });

    it("buckets always sum to the deck's card count", async () => {
      const db = getDb();
      const deck = await db.deck.create({ data: { name: "Mixed" } });
      for (const [state, interval] of [[0, 0], [1, 0], [2, 5], [2, 90], [3, 0]]) {
        await db.card.create({
          data: { deckId: deck.id, front: `Q${state}${interval}`, back: "A", state, interval },
        });
      }

      const [r] = await getMaturityReport();
      expect(r.new + r.learning + r.familiar + r.internalized).toBe(r.total);
      expect(r.total).toBe(5);
    });
  });

  describe("getLapsePatterns", () => {
    it("identifies cards with high lapse counts", async () => {
      const db = getDb();
      const deck = await db.deck.create({ data: { name: "React" } });
      const card = await db.card.create({
        data: {
          deckId: deck.id,
          front: "Hard question",
          back: "Hard answer",
          lapses: 5,
        },
      });

      const patterns = await getLapsePatterns();
      expect(patterns.length).toBe(1);
      expect(patterns[0].cardId).toBe(card.id);
      expect(patterns[0].lapses).toBe(5);
    });

    it("returns empty when no lapses", async () => {
      const patterns = await getLapsePatterns();
      expect(patterns.length).toBe(0);
    });
  });

  describe("getSessionHistory", () => {
    it("returns recent sessions ordered by date", async () => {
      const db = getDb();
      const older = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const newer = new Date(Date.now() - 24 * 60 * 60 * 1000);

      await db.studySession.create({
        data: {
          startTime: older,
          endTime: older,
          cardsReviewed: 3,
          accuracy: 0.8,
        },
      });
      await db.studySession.create({
        data: {
          startTime: newer,
          endTime: newer,
          cardsReviewed: 5,
          accuracy: 0.9,
        },
      });

      const history = await getSessionHistory(5);
      expect(history.length).toBe(2);
      expect(history[0].cardsReviewed).toBe(5); // newer first
    });
  });
});
