import { getDb } from "../db/client.js";
import {
  reviewCard as scheduleReview,
  getRetrievability,
  toSchedulableCard,
} from "./scheduler.js";
import {
  type MasterConfig,
  type SessionQueueItem,
  type SessionAdjustment,
  DEFAULT_CONFIG,
  Rating,
  State,
} from "./types.js";
import type { Grade } from "ts-fsrs";
import type { Card as PrismaCard } from "@prisma/client";

interface SessionState {
  queue: SessionQueueItem[];
  pointer: number;
  goodCount: number;
  /** Category filter the session was started with, for new-card top-ups. */
  category?: string;
}

const sessions = new Map<string, SessionState>();

interface StartSessionResult {
  id: string;
  queue: SessionQueueItem[];
}

export async function startSession(
  configOverrides?: Partial<MasterConfig> & { category?: string }
): Promise<StartSessionResult> {
  const db = getDb();

  const { category, ...configOnly } = configOverrides ?? {};
  const categoryFilter = category != null && category !== "" ? category : undefined;

  const savedConfig = await db.config.findUnique({ where: { id: "default" } });
  const filteredOverrides = Object.fromEntries(
    Object.entries(configOnly as Record<string, unknown>).filter(([, v]) => v !== undefined)
  ) as Partial<MasterConfig>;
  const config: MasterConfig = {
    ...DEFAULT_CONFIG,
    ...(savedConfig
      ? {
          maxNewCardsPerSession: savedConfig.maxNewCardsPerSession,
          maxReviewCardsPerSession: savedConfig.maxReviewCardsPerSession,
          practiceFirstMode: savedConfig.practiceFirstMode,
        }
      : {}),
    ...filteredOverrides,
  };

  const now = new Date();

  const dueReviewCards = await db.card.findMany({
    where: {
      due: { lte: now },
      suspended: false,
      state: { not: State.New },
      ...(categoryFilter !== undefined ? { category: categoryFilter } : {}),
    },
    orderBy: { due: "asc" },
  });

  const rankedReviews = dueReviewCards
    .map((card) => ({
      card,
      retrievability: getRetrievability(toSchedulableCard(card)),
    }))
    .sort((a, b) => a.retrievability - b.retrievability);

  const maxReviews = config.maxReviewCardsPerSession;
  const reviewQueue: SessionQueueItem[] = rankedReviews
    .slice(0, maxReviews)
    .map((r) => ({ cardId: r.card.id, reason: "due_review" as const }));

  // Reduce new card allowance when review-heavy
  let maxNew = config.maxNewCardsPerSession;
  if (reviewQueue.length > 10) {
    maxNew = Math.min(maxNew, 3);
  }

  const newCards = await db.card.findMany({
    where: {
      state: State.New,
      suspended: false,
      ...(categoryFilter !== undefined ? { category: categoryFilter } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: maxNew,
  });

  const unguidedQueue: SessionQueueItem[] = [];
  const guidedNewQueue: SessionQueueItem[] = [];
  for (const card of newCards) {
    if (config.practiceFirstMode && card.type === "unguided") {
      unguidedQueue.push({ cardId: card.id, reason: "unguided_priority" });
    } else {
      guidedNewQueue.push({ cardId: card.id, reason: "new_card" });
    }
  }

  const queue = [...unguidedQueue, ...reviewQueue, ...guidedNewQueue];
  const session = await db.studySession.create({ data: {} });

  sessions.set(session.id, {
    queue,
    pointer: 0,
    goodCount: 0,
    category: categoryFilter,
  });

  return { id: session.id, queue };
}

export async function getNextCard(
  sessionId: string
): Promise<PrismaCard | null> {
  const state = sessions.get(sessionId);
  if (!state) return null;

  const db = getDb();

  // Skip over queue items whose card no longer exists (e.g. deleted
  // mid-session). Without this, a deleted card at the pointer makes
  // findUnique return null, ending the session and stranding the
  // cards queued behind it. For each deleted card, pull in one
  // replacement new card so the session keeps its intended size.
  while (state.pointer < state.queue.length) {
    const item = state.queue[state.pointer];
    const card = await db.card.findUnique({ where: { id: item.cardId } });
    if (card) return card;
    state.pointer += 1;
    await topUpNewCard(state);
  }

  sessions.delete(sessionId);
  return null;
}

/**
 * Append one fresh new card to a session's queue, replacing a card that was
 * deleted mid-session. Picks the oldest unqueued New card, respecting the
 * session's category filter; does nothing when none is available.
 */
async function topUpNewCard(state: SessionState): Promise<void> {
  const db = getDb();
  const queuedIds = state.queue.map((item) => item.cardId);
  const replacement = await db.card.findFirst({
    where: {
      state: State.New,
      suspended: false,
      id: { notIn: queuedIds },
      ...(state.category !== undefined ? { category: state.category } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  if (replacement) {
    state.queue.push({ cardId: replacement.id, reason: "new_card" });
  }
}

export type ReviewSchedule = {
  /** ISO timestamp the card is next due. */
  due: string;
  /** Scheduled interval in days (0 for intra-day learning steps). */
  interval: number;
  /** FSRS state of the card after the review. */
  state: number;
  /** True when the card resurfaces in under a day (a learning step). */
  intraDay: boolean;
};

export async function submitReview(
  sessionId: string,
  cardId: string,
  rating: Grade,
  responseMs?: number
): Promise<ReviewSchedule> {
  const db = getDb();

  const card = await db.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Card not found: ${cardId}`);

  // Schedule via FSRS
  const schedulable = toSchedulableCard(card);
  const result = scheduleReview(schedulable, rating);

  // Update card with new scheduling
  await db.card.update({
    where: { id: cardId },
    data: {
      due: result.card.due,
      stability: result.card.stability,
      difficulty: result.card.difficulty,
      reps: result.card.reps,
      lapses: result.card.lapses,
      state: result.card.state,
      lastReview: result.card.lastReview,
      interval: result.card.interval,
    },
  });

  // Create review record
  await db.review.create({
    data: {
      cardId,
      rating,
      responseMs: responseMs ?? null,
      stability: result.card.stability,
      difficulty: result.card.difficulty,
      elapsedDays: result.log.elapsedDays,
    },
  });

  // A card resurfacing in under a day is an intra-day learning step.
  const intraDay =
    result.card.due.getTime() - Date.now() < 24 * 60 * 60 * 1000;

  // Update session stats
  const state = sessions.get(sessionId);
  const isNewCard = card.state === State.New;
  const isGood = rating === Rating.Good || rating === Rating.Easy;
  if (state) {
    state.goodCount += isGood ? 1 : 0;
    state.pointer += 1;

    // Re-queue intra-day learning steps so the card repeats this session
    if (intraDay) {
      state.queue.push({ cardId, reason: "learning_repeat" });
    }
  }
  const reviewed = state?.pointer ?? 1;
  const goodCount = state?.goodCount ?? (isGood ? 1 : 0);
  const accuracy = goodCount / reviewed;

  await db.studySession.update({
    where: { id: sessionId },
    data: {
      cardsReviewed: { increment: 1 },
      endTime: new Date(),
      accuracy,
      ...(isNewCard ? { newCards: { increment: 1 } } : {}),
    },
  });

  return {
    due: result.card.due.toISOString(),
    interval: result.card.interval,
    state: result.card.state,
    intraDay,
  };
}

export function skipCard(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  if (!state) return false;
  state.pointer += 1;
  return true;
}

export async function adjustSession(
  sessionId: string,
  adjustment: SessionAdjustment
): Promise<{ queue: SessionQueueItem[] }> {
  const state = sessions.get(sessionId);
  const queue = state?.queue ?? [];
  const pointer = state?.pointer ?? 0;

  let remaining = queue.slice(pointer);

  if (adjustment.maxCards !== undefined) {
    remaining = remaining.slice(0, adjustment.maxCards);
  }

  const cardFilter: Record<string, unknown> = {};
  if (adjustment.focusDeck != null && adjustment.focusDeck !== "") {
    cardFilter.deckId = adjustment.focusDeck;
  }
  if (adjustment.focusCategory != null && adjustment.focusCategory !== "") {
    cardFilter.category = adjustment.focusCategory;
  }

  if (Object.keys(cardFilter).length > 0 && remaining.length > 0) {
    const db = getDb();
    const matches = await db.card.findMany({
      where: { ...cardFilter, id: { in: remaining.map((item) => item.cardId) } },
      select: { id: true },
    });
    const matchIds = new Set(matches.map((c) => c.id));
    remaining = remaining.filter((item) => matchIds.has(item.cardId));
  }

  if (state) {
    state.queue = [...queue.slice(0, pointer), ...remaining];
  }

  return { queue: remaining };
}

