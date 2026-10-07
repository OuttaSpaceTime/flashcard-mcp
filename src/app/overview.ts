import { getDb } from "../db/client.js";
import { checkPressure, type PressureReport } from "../core/pressure.js";
import { checkCalibration, type CalibrationReport } from "../core/calibration.js";
import { getStudyStreak } from "../core/analytics-service.js";
import { cardMaturity } from "../core/scheduler.js";
import type { CardMaturity } from "../core/types.js";
import { State } from "../core/types.js";
import { visibleText } from "../core/content-rules.js";
import { localDay } from "../core/days.js";

/**
 * A rough picture of where studying stands: what is pending, how retention is
 * holding up, how the deck has matured, and the last week of reviews. One call,
 * shared by the Omvida bar panel (through `master overview`) and the Omvida app,
 * so the two never show different numbers.
 *
 * Every figure comes from the same core the MCP tools use. Pressure and
 * calibration are passed through whole, never recomputed: their verdicts drive
 * /study, and a second implementation drifted within a day the last time one
 * was written (see the study repo's AGENTS.md, "Flashcards in the viewer").
 */

export interface DayCount {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  reviews: number;
  /** Reviews rated Again on that day. */
  again: number;
}

export interface PendingCard {
  deck: string;
  /** Front with markup stripped, for a one-line preview. */
  text: string;
  lapses: number;
}

export interface Overview {
  pressure: PressureReport;
  calibration: CalibrationReport;
  streak: number;
  totalCards: number;
  maturity: Record<CardMaturity, number>;
  /** Oldest first, ending today: always `days` entries. */
  week: DayCount[];
  reviewedToday: number;
  /** Due review cards, most overdue first; new cards are a pool, not pending. */
  pending: PendingCard[];
}

/**
 * Reviews per local day for the `days` days ending today.
 */
export function bucketWeek(
  reviews: readonly { reviewedAt: Date; rating: number }[],
  now: Date,
  days = 7
): DayCount[] {
  const out: DayCount[] = [];
  const index = new Map<string, DayCount>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const entry = { day: localDay(d), reviews: 0, again: 0 };
    out.push(entry);
    index.set(entry.day, entry);
  }
  for (const r of reviews) {
    const entry = index.get(localDay(r.reviewedAt));
    if (entry == null) continue;
    entry.reviews += 1;
    if (r.rating === 1) entry.again += 1;
  }
  return out;
}

export async function getOverview(opts: { pendingLimit?: number; now?: Date } = {}): Promise<Overview> {
  const db = getDb();
  const now = opts.now ?? new Date();

  const [pressure, calibration, streak, cards, reviews, pending] = await Promise.all([
    checkPressure(),
    checkCalibration(),
    getStudyStreak(),
    db.card.findMany({ select: { state: true, interval: true, suspended: true } }),
    db.review.findMany({
      where: { reviewedAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6) } },
      select: { reviewedAt: true, rating: true },
    }),
    db.card.findMany({
      where: { due: { lte: now }, suspended: false, state: { not: State.New } },
      include: { deck: { select: { name: true } } },
      orderBy: { due: "asc" },
      take: opts.pendingLimit ?? 8,
    }),
  ]);

  const maturity: Record<CardMaturity, number> = { new: 0, learning: 0, familiar: 0, internalized: 0 };
  for (const card of cards) {
    if (!card.suspended) maturity[cardMaturity(card)] += 1;
  }

  const week = bucketWeek(reviews, now);

  return {
    pressure,
    calibration,
    streak,
    totalCards: cards.length,
    maturity,
    week,
    reviewedToday: week[week.length - 1]?.reviews ?? 0,
    pending: pending.map((c) => ({ deck: c.deck.name, text: visibleText(c.front), lapses: c.lapses })),
  };
}
