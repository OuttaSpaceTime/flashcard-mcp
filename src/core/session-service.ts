import { getDb } from "../db/client.js";
import { findUnresolvedLeeches, flagLeechOnServe, leechBlockError } from "./leeches.js";
import {
  reviewCard,
  getRetrievability,
  toSchedulableCard,
  type ReviewResult,
  type SchedulableCard,
} from "./scheduler.js";
import { dueReviewWhere, NEW_CARD_WHERE } from "./pressure.js";
import { MS_PER_DAY } from "./days.js";
import type { MasterConfig, SessionQueueItem, SessionAdjustment } from "./types.js";
import { Rating, State, type Grade } from "ts-fsrs";
import type { Card as PrismaCard, Config, Prisma, StudySession } from "@prisma/client";

interface SessionState {
  queue: SessionQueueItem[];
  /** Index of the card being served: advanced by a review, a skip or a deleted card. */
  pointer: number;
  /** Reviews submitted, the denominator of `accuracy` (skips are not reviews). */
  reviewed: number;
  /** Reviews rated Good or Easy. */
  goodCount: number;
  /**
   * Queue slots passed over because their card was deleted before it was
   * served. They never count as a position, so `getQueuePosition` subtracts
   * them from both the position and the total.
   */
  dropped: number;
  /** Category filter the session was started with, for new-card top-ups. */
  category?: string;
  /** Deck filter (id) the session was started with, for new-card top-ups. */
  deckId?: string;
}

/** The cards a session draws from, given the filters it was started with. */
function scopeWhere(filters: { category?: string; deckId?: string }): Prisma.CardWhereInput {
  return {
    ...(filters.category !== undefined ? { category: filters.category } : {}),
    ...(filters.deckId !== undefined ? { deckId: filters.deckId } : {}),
  };
}

/**
 * Open sessions. The map is this process's cache; the truth is
 * `StudySession.queueState`, written on every change, so a session survives a
 * restart of the server driving it (the MCP server, or the Omvida app's) and
 * any process can pick it up. One process drives a session at a time: a cache
 * is not shared, so two processes advancing the same session would race.
 */
const sessions = new Map<string, SessionState>();

/** The session's state from the cache, or from its row; undefined once ended. */
async function loadState(sessionId: string): Promise<SessionState | undefined> {
  const cached = sessions.get(sessionId);
  if (cached) return cached;
  const row = await getDb().studySession.findUnique({
    where: { id: sessionId },
    select: { queueState: true, endTime: true, cardsReviewed: true },
  });
  if (row?.queueState == null || row.endTime != null) return undefined;
  const saved = JSON.parse(row.queueState) as Omit<SessionState, "reviewed"> & { reviewed?: number };
  // A state saved before `reviewed` existed: the row counts the same reviews.
  const state: SessionState = { ...saved, reviewed: saved.reviewed ?? row.cardsReviewed };
  sessions.set(sessionId, state);
  return state;
}

async function saveState(sessionId: string, state: SessionState): Promise<void> {
  sessions.set(sessionId, state);
  await getDb().studySession.update({
    where: { id: sessionId },
    data: { queueState: JSON.stringify(state) },
  });
}

/** The queue is used up or the session ended: nothing left to resume. */
async function dropState(sessionId: string): Promise<void> {
  sessions.delete(sessionId);
  await getDb().studySession.updateMany({ where: { id: sessionId }, data: { queueState: null } });
}

/** The saved settings, created with the schema's defaults the first time. */
async function readConfig(): Promise<Config> {
  const db = getDb();
  const saved = await db.config.findUnique({ where: { id: "default" } });
  return saved ?? db.config.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
}

export interface StartSessionResult {
  id: string;
  queue: SessionQueueItem[];
  /** New cards queued (`new_card` and `unguided_priority` items). */
  newCount: number;
  /** Due review cards queued (`due_review` items). */
  reviewCount: number;
}

export async function startSession(
  configOverrides?: Partial<MasterConfig> & { category?: string; deckId?: string }
): Promise<StartSessionResult> {
  const db = getDb();
  await discardEmptySessions();

  const { category, deckId, ...overrides } = configOverrides ?? {};
  const filters = {
    category: category != null && category !== "" ? category : undefined,
    deckId: deckId != null && deckId !== "" ? deckId : undefined,
  };
  const scope = scopeWhere(filters);

  const saved = await readConfig();
  const config: MasterConfig = {
    maxNewCardsPerSession: overrides.maxNewCardsPerSession ?? saved.maxNewCardsPerSession,
    maxReviewCardsPerSession: overrides.maxReviewCardsPerSession ?? saved.maxReviewCardsPerSession,
    practiceFirstMode: overrides.practiceFirstMode ?? saved.practiceFirstMode,
  };

  const dueReviewCards = await db.card.findMany({
    where: { ...dueReviewWhere(), ...scope },
    orderBy: { due: "asc" },
  });

  const rankedReviews = dueReviewCards
    .map((card) => ({
      card,
      retrievability: getRetrievability(toSchedulableCard(card)),
    }))
    .sort((a, b) => a.retrievability - b.retrievability);

  const reviewQueue: SessionQueueItem[] = rankedReviews
    .slice(0, config.maxReviewCardsPerSession)
    .map((r) => ({ cardId: r.card.id, reason: "due_review" as const }));

  // Reduce new card allowance when review-heavy
  let maxNew = config.maxNewCardsPerSession;
  if (reviewQueue.length > 10) {
    maxNew = Math.min(maxNew, 3);
  }

  const newCards = await db.card.findMany({
    where: { ...NEW_CARD_WHERE, ...scope },
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
  const state: SessionState = {
    queue,
    pointer: 0,
    reviewed: 0,
    goodCount: 0,
    dropped: 0,
    ...filters,
  };
  const session = await db.studySession.create({ data: { queueState: JSON.stringify(state) } });
  sessions.set(session.id, state);

  return { id: session.id, queue, newCount: newCards.length, reviewCount: reviewQueue.length };
}

/**
 * The next card, a leech block, or null when the session is over (or unknown).
 * `blocked` holds every card whose leech flag is unanswered, oldest flag first.
 */
export type NextCard = { card: PrismaCard } | { blocked: PrismaCard[] } | null;

/**
 * `getNextCard` with the leech block returned as data rather than thrown: a GUI
 * needs the blocking card itself, to show it with the ways out.
 */
export async function getNextCardOrBlock(sessionId: string): Promise<NextCard> {
  // A leech flagged on the previous serve blocks the whole loop, not just this
  // session: the card has to be rewritten, split, dropped, or explicitly kept
  // before any more studying happens.
  const unresolved = await findUnresolvedLeeches();
  if (unresolved.length > 0) return { blocked: unresolved };

  const state = await loadState(sessionId);
  if (!state) return null;

  const db = getDb();

  // Skip over queue items whose card no longer exists (e.g. deleted
  // mid-session). Without this, a deleted card at the pointer makes
  // findUnique return null, ending the session and stranding the
  // cards queued behind it. For each deleted card, pull in one
  // replacement new card so the session keeps its intended size.
  let skippedDeleted = false;
  while (state.pointer < state.queue.length) {
    const item = state.queue[state.pointer];
    const card = await db.card.findUnique({ where: { id: item.cardId } });
    if (card) {
      if (skippedDeleted) await saveState(sessionId, state);
      return { card: await flagLeechOnServe(card) };
    }
    state.pointer += 1;
    state.dropped += 1;
    skippedDeleted = true;
    await topUpNewCard(state);
  }

  await dropState(sessionId);
  return null;
}

/** The next card, or null when the session is over; throws on a leech block. */
export async function getNextCard(sessionId: string): Promise<PrismaCard | null> {
  const next = await getNextCardOrBlock(sessionId);
  if (next == null) return null;
  if ("blocked" in next) throw leechBlockError(next.blocked);
  return next.card;
}

export interface QueuePosition {
  /** 1-based position of the card currently served. */
  position: number;
  /** Current session size: grows by one per intra-day re-queue. */
  total: number;
  /** True when the served card is an intra-day learning repeat. */
  repeat: boolean;
}

/**
 * Where the card most recently returned by `getNextCard` sits in the session.
 * Re-queued learning repeats raise the total; a skipped card keeps its
 * position; a deleted card's slot counts for neither (its top-up replacement
 * takes its place, so the total only drops when no new card is left).
 * Returns null for an unknown or exhausted session.
 */
export async function getQueuePosition(sessionId: string): Promise<QueuePosition | null> {
  const state = await loadState(sessionId);
  if (!state || state.pointer >= state.queue.length) return null;
  return {
    position: state.pointer + 1 - state.dropped,
    total: state.queue.length - state.dropped,
    repeat: state.queue[state.pointer].reason === "learning_repeat",
  };
}

/**
 * Append one fresh new card to a session's queue, replacing a card that was
 * deleted mid-session. Picks the oldest unqueued New card, respecting the
 * session's category and deck filters; does nothing when none is available.
 */
async function topUpNewCard(state: SessionState): Promise<void> {
  const replacement = await getDb().card.findFirst({
    where: {
      ...NEW_CARD_WHERE,
      id: { notIn: state.queue.map((item) => item.cardId) },
      ...scopeWhere(state),
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

function toReviewSchedule(result: ReviewResult, now: Date): ReviewSchedule {
  return {
    due: result.card.due.toISOString(),
    interval: result.card.interval,
    state: result.card.state,
    // A card resurfacing in under a day is an intra-day learning step.
    intraDay: result.card.due.getTime() - now.getTime() < MS_PER_DAY,
  };
}

/**
 * What each rating would schedule for a card, without writing anything: the
 * app shows it on the rating keys. It runs the same FSRS step (at the saved
 * request retention) and the same intra-day rule as `submitReview`, so a
 * rating lands where its key said, up to the minutes that pass between the
 * preview and the review.
 */
export async function previewSchedules(
  card: SchedulableCard,
  now: Date = new Date()
): Promise<Record<Grade, ReviewSchedule>> {
  const { requestRetention } = await readConfig();
  const schedulable = toSchedulableCard(card);
  const at = (rating: Grade) => toReviewSchedule(reviewCard(schedulable, rating, now, requestRetention), now);
  return { 1: at(1), 2: at(2), 3: at(3), 4: at(4) };
}

/**
 * Record a rating: reschedule the card, log the review, advance the session.
 * Refused unless the session is open (an ended, exhausted or unknown session
 * has no queue to advance and no accuracy to keep). The three writes are one
 * transaction, so a failure leaves none of them behind.
 */
export async function submitReview(
  sessionId: string,
  cardId: string,
  rating: Grade,
  responseMs?: number
): Promise<ReviewSchedule> {
  const state = await loadState(sessionId);
  if (state === undefined) {
    throw new Error(`Session ${sessionId} is not open: it was ended, ran out of cards, or does not exist`);
  }

  const db = getDb();
  const card = await db.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Card not found: ${cardId}`);

  const { requestRetention } = await readConfig();
  const now = new Date();
  const result = reviewCard(toSchedulableCard(card), rating, now, requestRetention);
  const schedule = toReviewSchedule(result, now);

  const isGood = rating === Rating.Good || rating === Rating.Easy;
  const next: SessionState = {
    ...state,
    pointer: state.pointer + 1,
    reviewed: state.reviewed + 1,
    goodCount: state.goodCount + (isGood ? 1 : 0),
    // An intra-day learning step repeats the card later this session.
    queue: schedule.intraDay ? [...state.queue, { cardId, reason: "learning_repeat" }] : state.queue,
  };

  await db.$transaction([
    // updatedAt stays: it means the card's content changed (the app's stamp,
    // handlers.ts), and a review is not that.
    db.card.update({
      where: { id: cardId },
      data: {
        updatedAt: card.updatedAt,
        due: result.card.due,
        stability: result.card.stability,
        difficulty: result.card.difficulty,
        reps: result.card.reps,
        lapses: result.card.lapses,
        state: result.card.state,
        lastReview: result.card.lastReview,
        interval: result.card.interval,
      },
    }),
    db.review.create({
      data: {
        cardId,
        rating,
        responseMs: responseMs ?? null,
        stability: result.card.stability,
        difficulty: result.card.difficulty,
        elapsedDays: result.elapsedDays,
      },
    }),
    db.studySession.update({
      where: { id: sessionId },
      data: {
        cardsReviewed: { increment: 1 },
        accuracy: next.goodCount / next.reviewed,
        ...(card.state === State.New ? { newCards: { increment: 1 } } : {}),
        queueState: JSON.stringify(next),
      },
    }),
  ]);
  sessions.set(sessionId, next);

  return schedule;
}

/** A session as `endSession` reports it, dates as ISO strings. */
export interface SessionSummary {
  id: string;
  startTime: string;
  endTime: string;
  cardsReviewed: number;
  newCards: number;
  /** Share of the session's reviews rated Good or Easy. */
  accuracy: number;
}

function toSessionSummary(session: StudySession & { endTime: Date }): SessionSummary {
  return {
    id: session.id,
    startTime: session.startTime.toISOString(),
    endTime: session.endTime.toISOString(),
    cardsReviewed: session.cardsReviewed,
    newCards: session.newCards,
    accuracy: session.accuracy,
  };
}

/**
 * Close a session. `endTime` means "this session was ended", nothing else —
 * reviews no longer touch it, so a row with a null `endTime` is genuinely still
 * open rather than merely idle.
 *
 * Idempotent: an already-closed session keeps its original `endTime`. Returns
 * null for an unknown session.
 */
export async function endSession(sessionId: string): Promise<SessionSummary | null> {
  const db = getDb();
  const session = await db.studySession.findUnique({ where: { id: sessionId } });
  if (session == null) return null;

  sessions.delete(sessionId);
  if (session.endTime != null) return toSessionSummary({ ...session, endTime: session.endTime });

  const endTime = new Date();
  const ended = await db.studySession.update({
    where: { id: sessionId },
    data: { endTime, queueState: null },
  });
  return toSessionSummary({ ...ended, endTime });
}

/**
 * Discard sessions that were started but never reviewed anything. A row with no
 * reviews carries no information, and these accumulate whenever a session is
 * opened and walked away from.
 *
 * Sessions that did review cards are left alone even when still open: we do not
 * know when they ended, and stamping them with the current time would invent a
 * duration. A null `endTime` on a session with reviews is the true statement
 * that it was never closed.
 */
async function discardEmptySessions(): Promise<void> {
  await getDb().studySession.deleteMany({ where: { endTime: null, cardsReviewed: 0 } });
}

export async function skipCard(sessionId: string): Promise<boolean> {
  const state = await loadState(sessionId);
  if (!state) return false;
  state.pointer += 1;
  await saveState(sessionId, state);
  return true;
}

export async function adjustSession(
  sessionId: string,
  adjustment: SessionAdjustment
): Promise<{ queue: SessionQueueItem[] }> {
  const state = await loadState(sessionId);
  const queue = state?.queue ?? [];
  const pointer = state?.pointer ?? 0;

  let remaining = queue.slice(pointer);

  if (adjustment.maxCards !== undefined) {
    remaining = remaining.slice(0, adjustment.maxCards);
  }

  const cardFilter: Prisma.CardWhereInput = {};
  if (adjustment.focusDeck != null && adjustment.focusDeck !== "") {
    cardFilter.deckId = adjustment.focusDeck;
  }
  if (adjustment.focusCategory != null && adjustment.focusCategory !== "") {
    cardFilter.category = adjustment.focusCategory;
  }

  if (Object.keys(cardFilter).length > 0 && remaining.length > 0) {
    const matches = await getDb().card.findMany({
      where: { ...cardFilter, id: { in: remaining.map((item) => item.cardId) } },
      select: { id: true },
    });
    const matchIds = new Set(matches.map((c) => c.id));
    remaining = remaining.filter((item) => matchIds.has(item.cardId));
  }

  if (state) {
    state.queue = [...queue.slice(0, pointer), ...remaining];
    await saveState(sessionId, state);
  }

  return { queue: remaining };
}
