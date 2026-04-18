import { describe, it, expect } from "vitest";
import {
  reviewCard,
  getRetrievability,
  createNewFsrsCard,
} from "../../src/core/scheduler.js";
import { Rating, State } from "ts-fsrs";

describe("scheduler", () => {
  describe("createNewFsrsCard", () => {
    it("creates a card with default FSRS fields", () => {
      const card = createNewFsrsCard();
      expect(card.stability).toBe(0);
      expect(card.difficulty).toBe(0);
      expect(card.reps).toBe(0);
      expect(card.lapses).toBe(0);
      expect(card.state).toBe(State.New);
      expect(card.due).toBeInstanceOf(Date);
    });
  });

  describe("reviewCard", () => {
    it("reviews a new card as Good and updates scheduling", () => {
      const prismaCard = {
        due: new Date(),
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        state: 0,
        lastReview: null,
        interval: 0,
      };

      const result = reviewCard(prismaCard, Rating.Good);

      expect(result.card.reps).toBe(1);
      expect(result.card.stability).toBeGreaterThan(0);
      expect(result.card.difficulty).toBeGreaterThan(0);
      expect(result.card.due.getTime()).toBeGreaterThan(Date.now());
      expect(result.card.lastReview).toBeInstanceOf(Date);

      expect(result.log.rating).toBe(Rating.Good);
    });

    it("reviews a card as Again and increments lapses if it was in Review state", () => {
      const now = new Date();
      const lastReview = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      const prismaCard = {
        due: now,
        stability: 10,
        difficulty: 5,
        reps: 5,
        lapses: 0,
        state: State.Review as number,
        lastReview,
        interval: 5,
      };

      const result = reviewCard(prismaCard, Rating.Again);

      expect(result.card.lapses).toBe(1);
      expect(result.card.state).toBe(State.Relearning);
    });

    it("does not modify the input prismaCard fields object", () => {
      const prismaCard = {
        due: new Date(),
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        state: 0,
        lastReview: null,
        interval: 0,
      };

      const origReps = prismaCard.reps;
      reviewCard(prismaCard, Rating.Good);
      expect(prismaCard.reps).toBe(origReps);
    });
  });

  describe("getRetrievability", () => {
    it("returns 1 for a card just reviewed", () => {
      const now = new Date();
      const prismaCard = {
        due: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
        stability: 5,
        difficulty: 5,
        reps: 3,
        lapses: 0,
        state: State.Review as number,
        lastReview: now,
        interval: 5,
      };

      const r = getRetrievability(prismaCard);
      expect(r).toBeGreaterThan(0.95);
      expect(r).toBeLessThanOrEqual(1);
    });

    it("returns lower value for a card not reviewed in a long time", () => {
      const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const prismaCard = {
        due: longAgo,
        stability: 5,
        difficulty: 5,
        reps: 3,
        lapses: 0,
        state: State.Review as number,
        lastReview: longAgo,
        interval: 5,
      };

      const r = getRetrievability(prismaCard);
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThan(0.5);
    });

    it("returns 0 for a new card with no reviews", () => {
      const prismaCard = {
        due: new Date(),
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        state: State.New as number,
        lastReview: null,
        interval: 0,
      };

      const r = getRetrievability(prismaCard);
      expect(r).toBe(0);
    });
  });
});
