import {
  fsrs,
  createEmptyCard,
  State,
  type Card as FsrsCard,
  type Grade,
  type RecordLogItem,
  type FSRS,
} from "ts-fsrs";

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
  log: {
    rating: number;
    state: number;
    due: Date;
    stability: number;
    difficulty: number;
    elapsedDays: number;
    review: Date;
  };
};

let scheduler: FSRS | null = null;

function getScheduler(): FSRS {
  scheduler ??= fsrs();
  return scheduler;
}

export function createNewFsrsCard(now?: Date): SchedulableCard {
  const card = createEmptyCard(now);
  return fromFsrsCard(card);
}

/** Convert any object with scheduling fields to a SchedulableCard */
export function toSchedulableCard(card: {
  due: Date;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: Date | null;
  interval: number;
}): SchedulableCard {
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

function toFsrsCard(prismaCard: SchedulableCard): FsrsCard {
  const elapsedDays =
    prismaCard.lastReview != null
      ? Math.max(
          0,
          (prismaCard.due.getTime() - prismaCard.lastReview.getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : 0;

  return {
    due: prismaCard.due,
    stability: prismaCard.stability,
    difficulty: prismaCard.difficulty,
    elapsed_days: elapsedDays,
    scheduled_days: prismaCard.interval,
    reps: prismaCard.reps,
    lapses: prismaCard.lapses,
    state: prismaCard.state as State,
    last_review: prismaCard.lastReview ?? undefined,
  } as FsrsCard;
}

function fromFsrsCard(fsrsCard: FsrsCard): SchedulableCard {
  return {
    due: fsrsCard.due instanceof Date ? fsrsCard.due : new Date(fsrsCard.due),
    stability: fsrsCard.stability,
    difficulty: fsrsCard.difficulty,
    reps: fsrsCard.reps,
    lapses: fsrsCard.lapses,
    state: fsrsCard.state as number,
    lastReview: fsrsCard.last_review
      ? fsrsCard.last_review instanceof Date
        ? fsrsCard.last_review
        : new Date(fsrsCard.last_review)
      : null,
    interval: fsrsCard.scheduled_days,
  };
}

function toReviewResult(item: RecordLogItem): ReviewResult {
  return {
    card: fromFsrsCard(item.card),
    log: {
      rating: item.log.rating,
      state: item.log.state,
      due: item.log.due instanceof Date ? item.log.due : new Date(item.log.due),
      stability: item.log.stability,
      difficulty: item.log.difficulty,
      elapsedDays: item.log.elapsed_days,
      review:
        item.log.review instanceof Date
          ? item.log.review
          : new Date(item.log.review),
    },
  };
}

/**
 * A non-New card must have a positive, finite stability. If it doesn't
 * (stability 0/negative/NaN — a corruption that ts-fsrs's forgetting curve
 * turns into NaN intervals and an Invalid Date `due`), the card was never
 * properly learned. Recover by re-initializing it as a New card so this
 * review acts as the first learning step.
 */
function sanitizeForReview(prismaCard: SchedulableCard): SchedulableCard {
  const stabilityValid =
    Number.isFinite(prismaCard.stability) && prismaCard.stability > 0;
  if (prismaCard.state !== State.New && !stabilityValid) {
    return {
      ...prismaCard,
      stability: 0,
      difficulty: 0,
      state: State.New,
      lastReview: null,
      interval: 0,
    };
  }
  return prismaCard;
}

export function reviewCard(
  prismaCard: SchedulableCard,
  rating: Grade,
  now?: Date
): ReviewResult {
  const f = getScheduler();
  const fsrsCard = toFsrsCard(sanitizeForReview(prismaCard));
  const item = f.next(fsrsCard, now ?? new Date(), rating);
  return toReviewResult(item);
}

export function getRetrievability(
  prismaCard: SchedulableCard,
  now?: Date
): number {
  if (prismaCard.state === State.New || prismaCard.lastReview == null) {
    return 0;
  }

  const f = getScheduler();
  const fsrsCard = toFsrsCard(prismaCard);
  const r = f.get_retrievability(fsrsCard, now ?? new Date());
  if (typeof r === "string") {
    return parseFloat(r) / 100;
  }
  return r;
}
