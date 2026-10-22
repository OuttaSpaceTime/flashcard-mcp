import {
  fsrs,
  createEmptyCard,
  Grades,
  State,
  type Card as FsrsCard,
  type Grade,
  type FSRS,
} from "ts-fsrs";
import type { CardMaturity } from "./types.js";

export type SchedulableCard = {
  due: Date;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: Date | null;
  interval: number;
};

export type ReviewResult = {
  card: SchedulableCard;
  /** Whole days since the card's previous review, as ts-fsrs counted them. */
  elapsedDays: number;
};

/** Days of interval at which a review card counts as mature (Anki's convention). */
export const MATURE_INTERVAL_DAYS = 21;

/** A rating a review can carry: 1 Again, 2 Hard, 3 Good, 4 Easy. */
export function isGrade(x: unknown): x is Grade {
  return (Grades as readonly unknown[]).includes(x);
}

/**
 * Derive a card's maturity from its schedule.
 *
 * Maturity is always computed, never stored: it is a function of `state` and
 * `interval`, both of which every review updates. A persisted copy would only
 * ever go stale — and did, reporting cards with hundreds of reps as "new".
 */
export function cardMaturity(card: { state: number; interval: number }): CardMaturity {
  if (card.state === State.New) return "new";
  if (card.state === State.Learning || card.state === State.Relearning) return "learning";
  return card.interval >= MATURE_INTERVAL_DAYS ? "internalized" : "familiar";
}

/** One scheduler per request retention; undefined is ts-fsrs's own default. */
const schedulers = new Map<number | undefined, FSRS>();

function getScheduler(requestRetention?: number): FSRS {
  let scheduler = schedulers.get(requestRetention);
  if (scheduler === undefined) {
    scheduler = fsrs(requestRetention === undefined ? {} : { request_retention: requestRetention });
    schedulers.set(requestRetention, scheduler);
  }
  return scheduler;
}

export function createNewFsrsCard(now?: Date): SchedulableCard {
  return fromFsrsCard(createEmptyCard(now));
}

/** The scheduling fields of any card-shaped object (a Prisma row, say). */
export function toSchedulableCard(card: SchedulableCard): SchedulableCard {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.lastReview,
    interval: card.interval,
  };
}

function toFsrsCard(card: SchedulableCard): FsrsCard {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    // ts-fsrs derives elapsed time from last_review and the review time itself
    // (the scheduler's init, and get_retrievability), never from this field.
    elapsed_days: 0,
    scheduled_days: card.interval,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as State,
    last_review: card.lastReview ?? undefined,
  };
}

function fromFsrsCard(fsrsCard: FsrsCard): SchedulableCard {
  return {
    due: fsrsCard.due,
    stability: fsrsCard.stability,
    difficulty: fsrsCard.difficulty,
    reps: fsrsCard.reps,
    lapses: fsrsCard.lapses,
    state: fsrsCard.state,
    lastReview: fsrsCard.last_review ?? null,
    interval: fsrsCard.scheduled_days,
  };
}

/**
 * A non-New card must have a positive, finite stability. If it doesn't
 * (stability 0/negative/NaN — a corruption that ts-fsrs's forgetting curve
 * turns into NaN intervals and an Invalid Date `due`), the card was never
 * properly learned. Recover by re-initializing it as a New card so this
 * review acts as the first learning step.
 */
function sanitizeForReview(card: SchedulableCard): SchedulableCard {
  const stabilityValid = Number.isFinite(card.stability) && card.stability > 0;
  if (card.state !== State.New && !stabilityValid) {
    return {
      ...card,
      stability: 0,
      difficulty: 0,
      state: State.New,
      lastReview: null,
      interval: 0,
    };
  }
  return card;
}

/**
 * Apply a rating. `requestRetention` is the recall probability FSRS schedules
 * the next review at (Config.requestRetention); omitted, ts-fsrs's default.
 */
export function reviewCard(
  card: SchedulableCard,
  rating: Grade,
  now: Date = new Date(),
  requestRetention?: number
): ReviewResult {
  const item = getScheduler(requestRetention).next(toFsrsCard(sanitizeForReview(card)), now, rating);
  return { card: fromFsrsCard(item.card), elapsedDays: item.log.elapsed_days };
}

/**
 * Probability of recalling the card at `now`, 0 for a card never reviewed. The
 * forgetting curve depends on stability alone, so no request retention here.
 */
export function getRetrievability(card: SchedulableCard, now: Date = new Date()): number {
  if (card.state === State.New || card.lastReview == null) return 0;
  return getScheduler().get_retrievability(toFsrsCard(card), now, false);
}
