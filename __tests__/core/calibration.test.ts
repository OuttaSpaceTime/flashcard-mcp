import { describe, it, expect, beforeEach } from "vitest";
import {
  MIN_REVIEWS,
  WINDOW_DAYS,
  GOOD_SHARE_CEILING,
  calibrationVerdict,
  checkCalibration,
  eligibleReviews,
  isMarginal,
  ratingMix,
  trueRetention,
  type CalibrationReview,
} from "../../src/core/calibration.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";
import { State } from "ts-fsrs";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const DAY = 24 * 3600 * 1000;

function row(
  rating: number,
  opts: { card?: string; daysAgo?: number; elapsed?: number; at?: Date } = {}
): CalibrationReview {
  return {
    cardId: opts.card ?? "c1",
    rating,
    reviewedAt: opts.at ?? new Date(NOW.getTime() - (opts.daysAgo ?? 1) * DAY),
    elapsedDays: opts.elapsed ?? 3,
  };
}

/** One review per distinct card so nothing is deduped away. */
function rowsFor(mix: { again?: number; hard?: number; good?: number; easy?: number }): CalibrationReview[] {
  const out: CalibrationReview[] = [];
  for (const [rating, count] of [
    [1, mix.again ?? 0],
    [2, mix.hard ?? 0],
    [3, mix.good ?? 0],
    [4, mix.easy ?? 0],
  ] as const) {
    for (let i = 0; i < count; i++) out.push(row(rating, { card: `c${rating}-${i}` }));
  }
  return out;
}

describe("calibration", () => {
  describe("eligibleReviews", () => {
    it("drops intra-day repeats (elapsed < 1 day)", () => {
      const keep = row(3, { card: "a", elapsed: 5 });
      const repeat = row(1, { card: "b", elapsed: 0 });
      expect(eligibleReviews([keep, repeat], WINDOW_DAYS, NOW, "UTC")).toEqual([keep]);
    });

    it("keeps only the first review per card per day", () => {
      const first = row(1, { card: "a", at: new Date(NOW.getTime() - 6 * 3600 * 1000) });
      const second = row(4, { card: "a", at: new Date(NOW.getTime() - 2 * 3600 * 1000) });
      expect(eligibleReviews([second, first], WINDOW_DAYS, NOW, "UTC")).toEqual([first]);
    });

    it("counts the same card on two different days twice", () => {
      const d1 = row(3, { card: "a", daysAgo: 1 });
      const d2 = row(3, { card: "a", daysAgo: 2 });
      expect(eligibleReviews([d1, d2], WINDOW_DAYS, NOW, "UTC")).toHaveLength(2);
    });

    it("excludes reviews outside the window", () => {
      const inside = row(3, { card: "a", daysAgo: 5 });
      const outside = row(3, { card: "b", daysAgo: 40 });
      expect(eligibleReviews([inside, outside], WINDOW_DAYS, NOW, "UTC")).toEqual([inside]);
    });

    it("buckets by the caller's calendar day, not UTC", () => {
      // A UTC+2 developer's 00:30 review is the same study day as their 15:00 one.
      const early = row(1, { card: "a", at: new Date("2026-07-27T22:30:00.000Z") });
      const later = row(3, { card: "a", at: new Date("2026-07-28T13:00:00.000Z") });
      const now = new Date("2026-07-28T18:00:00.000Z");
      expect(eligibleReviews([early, later], WINDOW_DAYS, now, "Europe/Berlin")).toEqual([early]);
    });

    it("would have split those two under a UTC clock — the bug this guards against", () => {
      const early = row(1, { card: "a", at: new Date("2026-07-27T22:30:00.000Z") });
      const later = row(3, { card: "a", at: new Date("2026-07-28T13:00:00.000Z") });
      const now = new Date("2026-07-28T18:00:00.000Z");
      expect(eligibleReviews([early, later], WINDOW_DAYS, now, "UTC")).toHaveLength(2);
    });
  });

  describe("trueRetention", () => {
    it("counts rating 3 or better as a pass", () => {
      expect(trueRetention(rowsFor({ again: 1, hard: 1, good: 1, easy: 1 }))).toBeCloseTo(0.5);
    });

    it("is null without eligible reviews", () => {
      expect(trueRetention([])).toBeNull();
    });

    it("counts each rating bucket", () => {
      expect(ratingMix(rowsFor({ again: 2, hard: 1, good: 5, easy: 2 }))).toEqual({
        again: 2,
        hard: 1,
        good: 5,
        easy: 2,
      });
    });
  });

  describe("calibrationVerdict", () => {
    it("reads low-signal below the minimum review count", () => {
      const { verdict, reasons } = calibrationVerdict(rowsFor({ good: MIN_REVIEWS - 1 }));
      expect(verdict).toBe("low-signal");
      expect(reasons.join(" ")).toMatch(/eligible reviews/);
    });

    it("reads low-signal when Good dominates the mix", () => {
      const { verdict, reasons } = calibrationVerdict(rowsFor({ again: 5, good: 45 }));
      expect(verdict).toBe("low-signal");
      expect(reasons.join(" ")).toMatch(/discrimination/);
    });

    it("reads over-difficult below 80%", () => {
      expect(calibrationVerdict(rowsFor({ again: 15, good: 35 })).verdict).toBe("over-difficult");
    });

    it("reads calibrated inside the band", () => {
      expect(calibrationVerdict(rowsFor({ again: 4, hard: 3, good: 35, easy: 8 })).verdict).toBe(
        "calibrated"
      );
    });

    it("reads under-difficult above 90%", () => {
      expect(calibrationVerdict(rowsFor({ again: 2, good: 38, easy: 10 })).verdict).toBe(
        "under-difficult"
      );
    });

    it("applies the discrimination gate before the retention bands", () => {
      const rows = rowsFor({ again: 5, good: 45 });
      expect(trueRetention(rows)).toBeCloseTo(0.9);
      expect(calibrationVerdict(rows).verdict).toBe("low-signal");
    });

    it("treats exactly 80% as calibrated", () => {
      const rows = rowsFor({ again: 10, good: 40 });
      expect(trueRetention(rows)).toBeCloseTo(0.8);
      expect(calibrationVerdict(rows).verdict).toBe("calibrated");
    });

    it("treats exactly 90% as calibrated", () => {
      const rows = rowsFor({ hard: 5, good: 40, easy: 5 });
      expect(trueRetention(rows)).toBeCloseTo(0.9);
      expect(calibrationVerdict(rows).verdict).toBe("calibrated");
    });

    it("keeps the Good ceiling exclusive: a mix exactly at the ceiling still grades", () => {
      const rows = rowsFor({ again: 12, good: 48 });
      expect(ratingMix(rows).good / rows.length).toBeCloseTo(GOOD_SHARE_CEILING);
      expect(calibrationVerdict(rows).verdict).toBe("calibrated");
    });
  });

  describe("isMarginal", () => {
    it("is true just below the floor", () => {
      expect(isMarginal("over-difficult", 0.79)).toBe(true);
    });

    it("is true just above the ceiling", () => {
      expect(isMarginal("under-difficult", 0.91)).toBe(true);
    });

    it("is false well inside the band", () => {
      expect(isMarginal("calibrated", 0.86)).toBe(false);
    });

    it("is false well below the band", () => {
      expect(isMarginal("over-difficult", 0.7)).toBe(false);
    });

    it("is false without a retention number", () => {
      expect(isMarginal("low-signal", null)).toBe(false);
    });

    it("is never true for low-signal, however close to an edge", () => {
      expect(isMarginal("low-signal", 0.79)).toBe(false);
    });

    it("counts a retention exactly MARGIN from the floor", () => {
      expect(isMarginal("over-difficult", 0.78)).toBe(true);
    });

    it("counts a retention exactly MARGIN from the ceiling", () => {
      expect(isMarginal("under-difficult", 0.92)).toBe(true);
    });

    it("stops a hair further out", () => {
      expect(isMarginal("over-difficult", 0.7799)).toBe(false);
    });
  });

  describe("checkCalibration over the database", () => {
    let deckId: string;

    beforeEach(async () => {
      const deck = await createDeck("CalibrationDeck");
      deckId = deck.id;
    });

    async function seedCard(): Promise<string> {
      const card = await getDb().card.create({
        data: {
          deckId,
          front: `card ${Math.random()}`,
          back: "a",
          state: State.Review,
        },
      });
      return card.id;
    }

    /** A review row written the way Prisma writes them today: ISO text. */
    async function seedReview(
      cardId: string,
      rating: number,
      daysAgo: number,
      elapsedDays = 3
    ): Promise<void> {
      await getDb().review.create({
        data: {
          cardId,
          rating,
          stability: 10,
          difficulty: 5,
          elapsedDays,
          reviewedAt: new Date(Date.now() - daysAgo * DAY),
        },
      });
    }

    /**
     * A review row written the way older Prisma wrote them: an epoch-ms INTEGER.
     * master.db holds ~75% of its history in this format.
     */
    async function seedIntegerReview(
      cardId: string,
      rating: number,
      daysAgo: number,
      elapsedDays = 3
    ): Promise<void> {
      await getDb().$executeRawUnsafe(
        `INSERT INTO Review (id, cardId, rating, stability, difficulty, elapsedDays, reviewedAt)
         VALUES (?, ?, ?, 10, 5, ?, ?)`,
        `int-${Math.random()}`,
        cardId,
        rating,
        elapsedDays,
        Date.now() - daysAgo * DAY
      );
    }

    it("reports no reviews on an empty deck", async () => {
      const report = await checkCalibration();
      expect(report.reviews).toBe(0);
      expect(report.true_retention).toBeNull();
      expect(report.verdict).toBe("low-signal");
      expect(report.marginal).toBe(false);
    });

    it("echoes the window and thresholds", async () => {
      const report = await checkCalibration();
      expect(report.window_days).toBe(WINDOW_DAYS);
      expect(report.thresholds).toEqual({
        min_reviews: MIN_REVIEWS,
        over_difficult_below: 0.8,
        under_difficult_above: 0.9,
        good_share_ceiling: GOOD_SHARE_CEILING,
      });
    });

    it("counts eligible reviews and their rating mix", async () => {
      const a = await seedCard();
      const b = await seedCard();
      await seedReview(a, 3, 2);
      await seedReview(b, 1, 3);
      await seedReview(b, 4, 40); // outside the window
      await seedReview(a, 2, 4, 0); // intra-day learning step

      const report = await checkCalibration();
      expect(report.reviews).toBe(2);
      expect(report.rating_mix).toEqual({ again: 1, hard: 0, good: 1, easy: 0 });
      expect(report.true_retention).toBeCloseTo(0.5);
    });

    it("sees reviews stored as epoch-ms integers", async () => {
      const a = await seedCard();
      const b = await seedCard();
      await seedIntegerReview(a, 3, 2);
      await seedIntegerReview(b, 1, 3);
      await seedReview(a, 3, 4);

      const report = await checkCalibration();
      expect(report.reviews).toBe(3);
      expect(report.rating_mix).toEqual({ again: 1, hard: 0, good: 2, easy: 0 });
    });

    it("windows integer-stored reviews the same as text ones", async () => {
      const a = await seedCard();
      await seedIntegerReview(a, 3, 2);
      await seedIntegerReview(a, 3, 400);

      expect((await checkCalibration()).reviews).toBe(1);
    });

    it("dedupes an integer row and a text row of the same card and day", async () => {
      const a = await seedCard();
      await seedIntegerReview(a, 1, 2);
      await seedReview(a, 4, 2);

      const report = await checkCalibration();
      expect(report.reviews).toBe(1);
    });
  });
});
