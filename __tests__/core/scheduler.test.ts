import { describe, it, expect } from "vitest";
import {
  reviewCard,
  getRetrievability,
  createNewFsrsCard,
  cardMaturity,
  isGrade,
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

      expect(result.elapsedDays).toBe(0);
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

    it("recovers a corrupt Review-state card with zero stability instead of producing NaN", () => {
      const now = new Date("2026-06-10T05:32:00.000Z");
      const lastReview = new Date("2026-06-03T04:00:00.000Z");
      const corrupt = {
        due: new Date("2026-06-10T04:00:00.000Z"),
        stability: 0, // invalid: a Review-state card should never have zero stability
        difficulty: 1,
        reps: 1,
        lapses: 0,
        state: State.Review as number,
        lastReview,
        interval: 7,
      };

      const result = reviewCard(corrupt, Rating.Good, now);

      expect(Number.isFinite(result.card.stability)).toBe(true);
      expect(result.card.stability).toBeGreaterThan(0);
      expect(Number.isFinite(result.card.interval)).toBe(true);
      expect(result.card.due).toBeInstanceOf(Date);
      expect(Number.isNaN(result.card.due.getTime())).toBe(false);
      expect(result.card.due.getTime()).toBeGreaterThan(now.getTime());
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

    it("schedules sooner at a higher request retention", () => {
      const now = new Date("2026-06-10T12:00:00.000Z");
      const card = {
        due: now,
        stability: 10,
        difficulty: 5,
        reps: 5,
        lapses: 0,
        state: State.Review as number,
        lastReview: new Date("2026-05-31T12:00:00.000Z"),
        interval: 10,
      };

      const strict = reviewCard(card, Rating.Good, now, { requestRetention: 0.95 });
      const lax = reviewCard(card, Rating.Good, now, { requestRetention: 0.8 });
      expect(strict.card.interval).toBeLessThan(lax.card.interval);
      expect(strict.elapsedDays).toBe(10);
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
      // FSRS-6's flatter forgetting curve leaves ~0.52 after a year at S=5.
      expect(r).toBeLessThan(0.6);
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

  describe("isGrade", () => {
    it("accepts the four ratings and nothing else", () => {
      expect([1, 2, 3, 4].every(isGrade)).toBe(true);
      for (const x of [0, 5, 2.5, "3", null, undefined]) expect(isGrade(x)).toBe(false);
    });
  });
});

describe("cardMaturity", () => {
  it("classifies an unseen card as new", () => {
    expect(cardMaturity({ state: State.New, interval: 0 })).toBe("new");
  });

  it("classifies learning and relearning as learning", () => {
    expect(cardMaturity({ state: State.Learning, interval: 0 })).toBe("learning");
    expect(cardMaturity({ state: State.Relearning, interval: 0 })).toBe("learning");
  });

  it("classifies a review card under 21 days as familiar", () => {
    expect(cardMaturity({ state: State.Review, interval: 20 })).toBe("familiar");
  });

  it("classifies a review card at 21 days as internalized", () => {
    expect(cardMaturity({ state: State.Review, interval: 21 })).toBe("internalized");
  });

  it("classifies a long-interval review card as internalized", () => {
    expect(cardMaturity({ state: State.Review, interval: 365 })).toBe("internalized");
  });

  it("ignores interval for a card that is not in review state", () => {
    expect(cardMaturity({ state: State.Relearning, interval: 400 })).toBe("learning");
  });

  it("returns one of the four CardMaturity values for every state", () => {
    const buckets = ["new", "learning", "familiar", "internalized"];
    for (const state of [State.New, State.Learning, State.Review, State.Relearning]) {
      expect(buckets).toContain(cardMaturity({ state, interval: 30 }));
    }
  });

  describe("Anki's learning steps", () => {
    const minutes = (r: { card: { due: Date } }, now: Date) => Math.round((r.card.due.getTime() - now.getTime()) / 60000);
    const now = new Date("2026-11-03T10:00:00Z");
    const fresh = () => createNewFsrsCard(now);

    it("shows 1m / 6m / 10m on a new card for steps 1m 10m", () => {
      // Hard on the first step is the mean of the two steps (5.5m, shown 6m).
      const a = [1, 2, 3].map((g) => minutes(reviewCard(fresh(), g as 1 | 2 | 3, now), now));
      expect(a[0]).toBe(1);
      expect(a[2]).toBe(10);
      expect(a[1]).toBeGreaterThanOrEqual(5);
      expect(a[1]).toBeLessThanOrEqual(6);
    });

    it("sends Again on the second step back to the first (1m), not 5m", () => {
      const first = reviewCard(fresh(), Rating.Good, now).card;
      expect(first.learningStep).toBe(1);
      const later = new Date(now.getTime() + 10 * 60000);
      expect(minutes(reviewCard(first, Rating.Again, later), later)).toBe(1);
    });

    it("uses the relearning step (10m) when a review card is failed", () => {
      const review = { due: now, stability: 20, difficulty: 5, reps: 5, lapses: 0, state: State.Review as number, lastReview: new Date(now.getTime() - 20 * 86400000), interval: 20 };
      expect(minutes(reviewCard(review, Rating.Again, now), now)).toBe(10);
    });

    it("reviews a New card that carries a leftover difficulty", () => {
      const card = { ...fresh(), difficulty: 5 };
      expect(minutes(reviewCard(card, Rating.Good, now), now)).toBe(10);
    });

    it("reviews a card whose stability is below the library's floor", () => {
      const review = { due: now, stability: 0.0001, difficulty: 5, reps: 1, lapses: 0, state: State.Review as number, lastReview: now, interval: 0 };
      expect(reviewCard(review, Rating.Good, now).card.stability).toBeGreaterThan(0);
    });

    it("follows steps passed in, as synced from Anki", () => {
      const r = reviewCard(fresh(), Rating.Good, now, { learningSteps: ["2m", "30m"] });
      expect(minutes(r, now)).toBe(30);
    });

    it("schedules differently with other FSRS weights", () => {
      const review = { due: now, stability: 20, difficulty: 5, reps: 5, lapses: 0, state: State.Review as number, lastReview: new Date(now.getTime() - 20 * 86400000), interval: 20 };
      const w = [0.2172, 1.1771, 3.2602, 16.1507, 7.0114, 0.57, 2.0966, 0.0069, 1.5261, 0.112, 1.0178, 1.849, 0.1133, 0.3127, 2.2934, 0.2191, 3.0004, 0.7536, 0.3332, 0.1437, 0.2];
      const base = reviewCard(review, Rating.Good, now).card.interval;
      expect(reviewCard(review, Rating.Good, now, { weights: w }).card.interval).not.toBe(base);
    });
  });
});
