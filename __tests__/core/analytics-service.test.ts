import { describe, it, expect } from "vitest";
import {
  getStudyStreak,
  getRetentionByDeck,
  getWeeklyStats,
  getMaturityReport,
  getLapsePatterns,
  getSessionHistory,
} from "../../src/core/analytics-service.js";
import { getDb } from "../../src/db/client.js";
import { State, Rating } from "ts-fsrs";

describe("analytics-service", () => {
  describe("getStudyStreak", () => {
    it("returns 0 when no sessions exist", async () => {
      const streak = await getStudyStreak();
      expect(streak).toBe(0);
    });

    it("returns 1 for a session today", async () => {
      const db = getDb();
      await db.studySession.create({
        data: { cardsReviewed: 5, endTime: new Date() },
      });

      const streak = await getStudyStreak();
      expect(streak).toBe(1);
    });

    it("counts consecutive days", async () => {
      const db = getDb();
      const today = new Date();
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);

      for (const date of [today, yesterday, twoDaysAgo]) {
        await db.studySession.create({
          data: {
            startTime: date,
            endTime: date,
            cardsReviewed: 5,
          },
        });
      }

      const streak = await getStudyStreak();
      expect(streak).toBe(3);
    });

    it("breaks streak on gap day", async () => {
      const db = getDb();
      const today = new Date();
      const twoDaysAgo = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);

      await db.studySession.create({
        data: { startTime: today, endTime: today, cardsReviewed: 5 },
      });
      await db.studySession.create({
        data: {
          startTime: twoDaysAgo,
          endTime: twoDaysAgo,
          cardsReviewed: 5,
        },
      });

      const streak = await getStudyStreak();
      expect(streak).toBe(1);
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
    it("reports maturity distribution per deck", async () => {
      const db = getDb();
      const deck = await db.deck.create({ data: { name: "React" } });
      await db.card.create({
        data: {
          deckId: deck.id,
          front: "Q1",
          back: "A1",
          maturity: "new",
        },
      });
      await db.card.create({
        data: {
          deckId: deck.id,
          front: "Q2",
          back: "A2",
          maturity: "familiar",
        },
      });
      await db.card.create({
        data: {
          deckId: deck.id,
          front: "Q3",
          back: "A3",
          maturity: "internalized",
        },
      });

      const report = await getMaturityReport();
      expect(report.length).toBe(1);
      expect(report[0].deckName).toBe("React");
      expect(report[0].new).toBe(1);
      expect(report[0].familiar).toBe(1);
      expect(report[0].internalized).toBe(1);
      expect(report[0].total).toBe(3);
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
