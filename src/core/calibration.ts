import { getDb } from "../db/client.js";

/**
 * Study calibration — true retention, rating discrimination, difficulty verdict.
 *
 * Answers one question: is /study asking questions at the right difficulty?
 *
 * Retention is computed the way Anki's true-retention convention defines it,
 * because the naive "fraction of ratings >= 3 this session" number is inflated
 * by intra-day relearning repeats and by new cards being acquired rather than
 * retrieved. Two filters do the work:
 *
 * - `elapsedDays >= 1` drops same-day repeats. A review with no elapsed interval
 *   is a learning step, not a retrieval test of a scheduled memory. The Review
 *   table stores no card state, so elapsed interval is the usable proxy for
 *   "this card was actually due".
 * - first review per (card, day) keeps a card that lapsed and was re-served from
 *   being counted twice.
 *
 * The verdict feeds the difficulty levers in /study Phase 2. It never feeds the
 * rating rubric: Claude's own ratings produce this number, so letting it move
 * what counts as correct would make lenient grading the cheapest way to look
 * calibrated.
 */

export const WINDOW_DAYS = 30;
export const MIN_REVIEWS = 50;

export const OVER_DIFFICULT_BELOW = 0.8;
export const UNDER_DIFFICULT_ABOVE = 0.9;
export const GOOD_SHARE_CEILING = 0.8;
export const MARGIN = 0.02;

export type CalibrationVerdict =
  | "over-difficult"
  | "calibrated"
  | "under-difficult"
  | "low-signal";

export interface CalibrationReview {
  cardId: string;
  rating: number;
  reviewedAt: Date;
  elapsedDays: number;
}

export interface RatingMix {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

/**
 * The report as printed by `master calibration` and returned by
 * `check_calibration`. Field names are snake_case because this object is a wire
 * format: the study repo's /study skill parses it by name, so renaming a field
 * breaks that consumer.
 */
export interface CalibrationReport {
  verdict: CalibrationVerdict;
  marginal: boolean;
  /** null when no eligible review is in the window. */
  true_retention: number | null;
  reviews: number;
  window_days: number;
  rating_mix: RatingMix;
  reasons: string[];
  thresholds: {
    min_reviews: number;
    over_difficult_below: number;
    under_difficult_above: number;
    good_share_ceiling: number;
  };
}

const RATING_NAMES: Record<number, keyof RatingMix> = {
  1: "again",
  2: "hard",
  3: "good",
  4: "easy",
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Reviews that count toward true retention, oldest first.
 *
 * Calendar days are taken in `timeZone` (the developer's own zone by default),
 * not UTC. A study day is a local day: bucketing a UTC+2 developer's reviews by
 * UTC date would split everything before 02:00 local into the previous day, so a
 * lapse and its retest would count as two separate days instead of one.
 */
export function eligibleReviews(
  rows: CalibrationReview[],
  windowDays: number,
  now: Date = new Date(),
  timeZone: string = systemTimeZone()
): CalibrationReview[] {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const inWindow = rows
    .filter((r) => r.reviewedAt.getTime() >= cutoff && r.elapsedDays >= 1)
    .sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime());

  // en-CA renders as YYYY-MM-DD, so the formatted day doubles as its own key.
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const firstPerCardDay = new Map<string, CalibrationReview>();
  for (const review of inWindow) {
    const key = `${review.cardId}|${day.format(review.reviewedAt)}`;
    if (!firstPerCardDay.has(key)) firstPerCardDay.set(key, review);
  }
  return [...firstPerCardDay.values()];
}

export function ratingMix(rows: CalibrationReview[]): RatingMix {
  const mix: RatingMix = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const row of rows) mix[RATING_NAMES[row.rating]] += 1;
  return mix;
}

function passRate(rows: CalibrationReview[]): number {
  return rows.filter((r) => r.rating >= 3).length / rows.length;
}

export function trueRetention(rows: CalibrationReview[]): number | null {
  return rows.length === 0 ? null : passRate(rows);
}

/**
 * True when a retention-derived verdict sits within MARGIN of a band edge.
 *
 * The band edges are hard cutoffs applied to a noisy estimator, so a value a
 * point outside the band is not evidence of a real difficulty problem. Callers
 * use this to soften the lever response instead of flipping it: at 79% the
 * verdict is honestly `over-difficult`, but a single review would move it, so
 * switching every lever off would be an overreaction to noise.
 *
 * `low-signal` is never marginal. That verdict means retention itself is not
 * trustworthy yet, so qualifying it by distance-to-a-band-edge would contradict
 * the reason it was returned.
 */
export function isMarginal(verdict: CalibrationVerdict, retention: number | null): boolean {
  if (retention == null || verdict === "low-signal") return false;
  return [OVER_DIFFICULT_BELOW, UNDER_DIFFICULT_ABOVE].some(
    // Rounded because 0.78 is exactly MARGIN from the floor in decimal but a
    // hair over it in binary floating point.
    (edge) => Number(Math.abs(retention - edge).toFixed(6)) <= MARGIN
  );
}

export function calibrationVerdict(rows: CalibrationReview[]): {
  verdict: CalibrationVerdict;
  reasons: string[];
} {
  if (rows.length < MIN_REVIEWS) {
    return {
      verdict: "low-signal",
      reasons: [`only ${rows.length} eligible reviews (need ${MIN_REVIEWS})`],
    };
  }

  const goodShare = ratingMix(rows).good / rows.length;
  if (goodShare > GOOD_SHARE_CEILING) {
    return {
      verdict: "low-signal",
      reasons: [
        `poor discrimination: ${pct(goodShare)} of ratings are Good (ceiling ${pct(GOOD_SHARE_CEILING)}) — retention is not meaningful until grading spreads across all four ratings`,
      ],
    };
  }

  const retention = passRate(rows);
  if (retention < OVER_DIFFICULT_BELOW) {
    return {
      verdict: "over-difficult",
      reasons: [`true retention ${pct(retention)} (below ${pct(OVER_DIFFICULT_BELOW)})`],
    };
  }
  if (retention > UNDER_DIFFICULT_ABOVE) {
    return {
      verdict: "under-difficult",
      reasons: [`true retention ${pct(retention)} (above ${pct(UNDER_DIFFICULT_ABOVE)})`],
    };
  }
  return {
    verdict: "calibrated",
    reasons: [
      `true retention ${pct(retention)} (target ${pct(OVER_DIFFICULT_BELOW)}-${pct(UNDER_DIFFICULT_ABOVE)})`,
    ],
  };
}

/**
 * Every review row, decoded to Date, windowed in JS rather than in SQL.
 *
 * `Review.reviewedAt` holds epoch-ms INTEGERs (written by older Prisma) beside
 * ISO TEXT (written by current Prisma) — master.db is ~75% integer. SQLite
 * orders every INTEGER before every TEXT regardless of the instant each
 * represents, so `where: { reviewedAt: { gte: cutoff } }` silently drops integer
 * rows: measured against master.db, a 400-day cutoff matched 666 rows where 1849
 * qualify. Prisma decodes both storage formats correctly on read, so pulling the
 * rows and filtering them here is the exact version of the same query.
 */
async function readReviews(): Promise<CalibrationReview[]> {
  const db = getDb();
  return db.review.findMany({
    select: { cardId: true, rating: true, reviewedAt: true, elapsedDays: true },
  });
}

export async function checkCalibration(): Promise<CalibrationReport> {
  const rows = eligibleReviews(await readReviews(), WINDOW_DAYS);
  const { verdict, reasons } = calibrationVerdict(rows);
  const retention = trueRetention(rows);

  return {
    verdict,
    marginal: isMarginal(verdict, retention),
    true_retention: retention,
    reviews: rows.length,
    window_days: WINDOW_DAYS,
    rating_mix: ratingMix(rows),
    reasons,
    thresholds: {
      min_reviews: MIN_REVIEWS,
      over_difficult_below: OVER_DIFFICULT_BELOW,
      under_difficult_above: UNDER_DIFFICULT_ABOVE,
      good_share_ceiling: GOOD_SHARE_CEILING,
    },
  };
}
