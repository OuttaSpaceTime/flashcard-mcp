import { getDb } from "../db/client.js";
import { assertCardContent } from "./content-rules.js";
import { assertCanCreateCard } from "./pressure.js";
import { leechResolutionFor } from "./leeches.js";
import { createNewFsrsCard, type SchedulableCard } from "./scheduler.js";
import {
  checkDuplicate,
  findSimilarCards,
  getEmbedding,
  isEmbeddingsReady,
  COSINE_MATCH,
  JACCARD_SIMILAR,
  type DuplicateCheckResult,
  type SemanticOptions,
  type SimilarCard,
} from "./embeddings.js";
import { CARD_STATE_NAMES, parseTags, serializeTags, type CardStateName, type CardType } from "./types.js";
import type { Card as PrismaCard, Prisma } from "@prisma/client";
import type { State } from "ts-fsrs";

/**
 * A card's whole schedule brought in from elsewhere (an .apkg import): the
 * FSRS block plus suspension, written as is.
 */
export type CarriedSchedule = SchedulableCard & { suspended: boolean };

interface CreateCardInput {
  deckId: string;
  front: string;
  back: string;
  tags?: string[];
  type?: CardType;
  category?: string | null;
  checkDuplicates?: boolean;
  /**
   * Card id to inherit the FSRS scheduling block from (due, stability,
   * difficulty, reps, lapses, state, lastReview, interval). Used when
   * splitting or otherwise deriving a card from an existing one, so the new card
   * keeps the parent's learned schedule instead of resetting to a fresh New card.
   */
  inheritFrom?: string;
  /** The schedule a card brings with it from an import; ignored with `inheritFrom`. */
  schedule?: CarriedSchedule;
  /**
   * Skip the per-card SRS pressure gate. Only for batch writers that check
   * pressure once up front for the whole batch (importCards in card-import.ts),
   * so an import is refused atomically instead of aborting half-applied.
   */
  skipPressureGate?: boolean;
}

interface CreateCardResult {
  card: PrismaCard;
  duplicateWarning?: DuplicateCheckResult;
}

export type CardWithDeck = PrismaCard & { deck: { name: string } };

const WITH_DECK_NAME = { deck: { select: { name: true } } } as const;

/** Stored embeddings cover front and back, so every query embedding does too. */
function cardEmbeddingText(front: string, back: string): string {
  return `${front} ${back}`;
}

function applyCategoryFilter(where: Prisma.CardWhereInput, cat: string | undefined): void {
  if (cat === "__uncategorized__") where.category = null;
  else if (cat === "__any__") where.category = { not: null };
  else if (cat != null && cat !== "") where.category = cat;
}

/** Card.state number for each state name (ts-fsrs `State`). */
export const CARD_STATE_BY_NAME = Object.fromEntries(
  CARD_STATE_NAMES.map((name, state) => [name, state as State])
) as Record<CardStateName, State>;

function dueWhere(): Prisma.CardWhereInput {
  return { due: { lte: new Date() }, suspended: false };
}

function scheduleEmbeddingUpdate(cardId: string, front: string, back: string): void {
  const db = getDb();
  void getEmbedding(cardEmbeddingText(front, back)).then((emb) => {
    if (emb) {
      db.card
        .update({ where: { id: cardId }, data: { embedding: JSON.stringify(emb) } })
        .catch(() => {});
    }
  });
}

export async function createCard(input: CreateCardInput): Promise<CreateCardResult> {
  assertCardContent({ front: input.front, back: input.back });
  const db = getDb();

  // Splits/derives (inheritFrom) are exempt: they inherit an existing schedule,
  // so they are already-seen material being reshaped, not new load.
  if (input.inheritFrom == null && input.skipPressureGate !== true) {
    await assertCanCreateCard();
  }

  // Scheduling block: fresh FSRS defaults or the one an import carries, unless
  // deriving from a parent card (split) — then inherit the parent's learned
  // schedule so the new card keeps its place in the queue instead of
  // resurfacing immediately.
  let schedule: SchedulableCard = input.schedule ?? createNewFsrsCard();
  if (input.inheritFrom != null) {
    const parent = await db.card.findUnique({ where: { id: input.inheritFrom } });
    if (parent == null) {
      throw new Error(`inheritFrom: card "${input.inheritFrom}" not found`);
    }
    schedule = {
      due: parent.due,
      stability: parent.stability,
      difficulty: parent.difficulty,
      reps: parent.reps,
      // Splitting a flagged leech is one of the ways out of the block, so the
      // derived card starts with a clean failure record — the parent's lapses
      // were earned by wording this card no longer has. The flag columns are
      // never copied at all.
      lapses: parent.leechFlaggedAt != null ? 0 : parent.lapses,
      state: parent.state,
      lastReview: parent.lastReview,
      interval: parent.interval,
    };
  }

  let duplicateWarning: DuplicateCheckResult | undefined;

  if (input.checkDuplicates === true) {
    const existingCards = await db.card.findMany({
      where: { deckId: input.deckId },
      select: { id: true, front: true, embedding: true },
    });

    let semantic: SemanticOptions | undefined;
    if (isEmbeddingsReady()) {
      const queryEmb = await getEmbedding(cardEmbeddingText(input.front, input.back));
      if (queryEmb) semantic = { queryEmbedding: queryEmb, cosineThreshold: COSINE_MATCH };
    }

    const dupResult = checkDuplicate(input.front, existingCards, semantic);
    if (dupResult.similarCards.length > 0) duplicateWarning = dupResult;
  }

  const card = await db.card.create({
    data: {
      deckId: input.deckId,
      front: input.front,
      back: input.back,
      tags: serializeTags(input.tags),
      type: input.type ?? "guided",
      category: input.category ?? null,
      inheritedFrom: input.inheritFrom ?? null,
      due: schedule.due,
      stability: schedule.stability,
      difficulty: schedule.difficulty,
      reps: schedule.reps,
      lapses: schedule.lapses,
      state: schedule.state,
      lastReview: schedule.lastReview,
      interval: schedule.interval,
      suspended: input.inheritFrom == null && input.schedule?.suspended === true,
    },
  });

  scheduleEmbeddingUpdate(card.id, card.front, card.back);

  return { card, duplicateWarning };
}

export async function backfillEmbeddings(
  onProgress?: (done: number, total: number) => void
): Promise<{ processed: number; failed: number }> {
  const db = getDb();
  const cards = await db.card.findMany({
    where: { embedding: null },
    select: { id: true, front: true, back: true },
  });

  let processed = 0;
  let failed = 0;

  for (const card of cards) {
    const emb = await getEmbedding(cardEmbeddingText(card.front, card.back));
    if (emb) {
      await db.card.update({
        where: { id: card.id },
        data: { embedding: JSON.stringify(emb) },
      });
      processed++;
    } else {
      failed++;
    }

    onProgress?.(processed + failed, cards.length);
  }

  return { processed, failed };
}

/** How many cards have an embedding, out of all of them. */
export async function embeddingCoverage(): Promise<{ total: number; embedded: number }> {
  const db = getDb();
  const [total, embedded] = await Promise.all([
    db.card.count(),
    db.card.count({ where: { embedding: { not: null } } }),
  ]);
  return { total, embedded };
}

/** Every category in use (null: uncategorized) with its card count. */
export async function listCategories(): Promise<Array<{ category: string | null; cards: number }>> {
  const rows = await getDb().card.groupBy({ by: ["category"], _count: { _all: true } });
  return rows.map((row) => ({ category: row.category, cards: row._count._all }));
}

/** Put every card of a deck in `category`; returns how many cards that was. */
export async function setDeckCategory(deckId: string, category: string): Promise<number> {
  const res = await getDb().card.updateMany({ where: { deckId }, data: { category } });
  return res.count;
}

export async function getCard(id: string): Promise<PrismaCard | null> {
  const db = getDb();
  return db.card.findUnique({ where: { id } });
}

/**
 * Edit a card. Content is checked, an answered leech flag is cleared, and the
 * embedding follows a changed front or back. `schedule` replaces the whole
 * schedule (an import's --theirs side); its lapse count wins over the flag
 * clearing's reset, since it is the history the card now carries.
 */
export async function updateCard(
  id: string,
  updates: {
    front?: string;
    back?: string;
    tags?: string;
    category?: string | null;
    schedule?: CarriedSchedule;
  }
): Promise<PrismaCard> {
  assertCardContent({ front: updates.front, back: updates.back });
  const db = getDb();
  const { schedule, ...fields } = updates;
  const updated = await db.card.update({
    where: { id },
    data: { ...fields, ...(await leechResolutionFor(id)), ...schedule },
  });

  if (updates.front !== undefined || updates.back !== undefined) {
    scheduleEmbeddingUpdate(id, updated.front, updated.back);
  }

  return updated;
}

export async function suspendCard(id: string): Promise<PrismaCard> {
  const db = getDb();
  return db.card.update({ where: { id }, data: { suspended: true } });
}

export async function unsuspendCard(id: string): Promise<PrismaCard> {
  const db = getDb();
  return db.card.update({ where: { id }, data: { suspended: false } });
}

/**
 * Records the deletion of these cards; every delete (card, cards, deck) writes
 * one in the same transaction. anki-sync needs it to tell a card deleted here
 * from one created on another machine and not yet synced down: both look like
 * "no row" otherwise, and guessing either way destroys cards.
 */
export async function tombstone(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
  for (const cardId of ids) {
    await tx.deletedCard.upsert({ where: { cardId }, create: { cardId }, update: {} });
  }
}

export async function deleteCard(id: string): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    await tombstone(tx, [id]);
    await tx.card.delete({ where: { id } });
  });
}

export async function deleteCards(ids: string[]): Promise<{ deleted: number }> {
  if (ids.length === 0) return { deleted: 0 };
  const db = getDb();
  return db.$transaction(async (tx) => {
    const existing = (await tx.card.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c) => c.id);
    await tombstone(tx, existing);
    const res = await tx.card.deleteMany({ where: { id: { in: existing } } });
    return { deleted: res.count };
  });
}

/**
 * Cards matching `where` whose tags include every one of `tags` exactly.
 * SQL `contains` narrows the pool but false-positives ("foo" inside "foobar"),
 * so the match is finished in JS over a bounded over-fetch.
 */
async function findCards(
  where: Prisma.CardWhereInput,
  tags: string[],
  orderBy: Prisma.CardOrderByWithRelationInput,
  offset: number,
  limit: number
): Promise<CardWithDeck[]> {
  const db = getDb();
  if (tags.length === 0) {
    return db.card.findMany({ where, include: WITH_DECK_NAME, orderBy, skip: offset, take: limit });
  }
  const candidates = await db.card.findMany({
    where: { ...where, AND: tags.map((tag) => ({ tags: { contains: tag } })) },
    include: WITH_DECK_NAME,
    orderBy,
    take: (offset + limit) * 4,
  });
  return candidates
    .filter((c) => {
      const cardTags = parseTags(c.tags);
      return tags.every((tag) => cardTags.includes(tag));
    })
    .slice(offset, offset + limit);
}

export async function listCards(filters: {
  deckId?: string;
  /** "empty" (no tags), "has_any", or one tag the card must carry exactly. */
  tagFilter?: string;
  category?: string;
  state?: string;
  /** Only cards due now (unsuspended, due ≤ now). */
  due?: boolean;
  /** "created": newest first (default); "due": soonest due first. */
  orderBy?: "created" | "due";
  limit?: number;
  offset?: number;
}): Promise<CardWithDeck[]> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
  const offset = Math.max(0, filters.offset ?? 0);

  const where: Prisma.CardWhereInput = filters.due === true ? dueWhere() : {};
  if (filters.deckId != null && filters.deckId !== "") {
    where.deckId = filters.deckId;
  }

  if (filters.state != null && filters.state !== "") {
    const state = CARD_STATE_NAMES.indexOf(filters.state as CardStateName);
    if (state < 0) {
      throw new Error(`Invalid state "${filters.state}". Expected one of: ${CARD_STATE_NAMES.join(", ")}`);
    }
    where.state = state;
  }

  applyCategoryFilter(where, filters.category);

  const tf = filters.tagFilter;
  if (tf === "empty") where.tags = "";
  else if (tf === "has_any") where.tags = { not: "" };
  const exactTags = tf != null && tf !== "" && tf !== "empty" && tf !== "has_any" ? [tf] : [];

  const orderBy: Prisma.CardOrderByWithRelationInput =
    filters.orderBy === "due" ? { due: "asc" } : { createdAt: "desc" };
  return findCards(where, exactTags, orderBy, offset, limit);
}

/** Cards whose front or back contains `query`, newest first; each tag must match exactly. */
export async function searchCards(
  query: string,
  filters: {
    deckId?: string;
    tags?: string[];
    category?: string;
    limit?: number;
  } = {}
): Promise<CardWithDeck[]> {
  const where: Prisma.CardWhereInput = {};

  if (query !== "") {
    where.OR = [{ front: { contains: query } }, { back: { contains: query } }];
  }

  if (filters.deckId != null && filters.deckId !== "") {
    where.deckId = filters.deckId;
  }

  applyCategoryFilter(where, filters.category);

  return findCards(where, filters.tags ?? [], { createdAt: "desc" }, 0, filters.limit ?? 100);
}

/** Unsuspended cards due now, soonest first. Counts New cards too: not the review backlog. */
export async function getDueCards(limit: number = 30): Promise<CardWithDeck[]> {
  const db = getDb();
  return db.card.findMany({
    where: dueWhere(),
    include: WITH_DECK_NAME,
    take: limit,
    orderBy: { due: "asc" },
  });
}

/** How many cards getDueCards would return without a limit. */
export async function countDueCards(): Promise<number> {
  return getDb().card.count({ where: dueWhere() });
}

/** Every card with its deck name, newest first. */
export async function allCards(): Promise<CardWithDeck[]> {
  return getDb().card.findMany({ include: WITH_DECK_NAME, orderBy: { createdAt: "desc" } });
}

/**
 * Cards similar to `text`: Jaccard word overlap against each card's front,
 * then (once embeddings are loaded) cosine similarity against each card's
 * front+back embedding. Pass a card's front and back joined by a space for
 * the semantic stage to compare like with like, as createCard does.
 */
export async function findSimilar(
  text: string,
  opts: { deckId?: string; jaccardThreshold?: number; cosineThreshold?: number } = {}
): Promise<SimilarCard[]> {
  const db = getDb();
  const existingCards = await db.card.findMany({
    where: opts.deckId != null && opts.deckId !== "" ? { deckId: opts.deckId } : {},
    select: { id: true, front: true, embedding: true },
  });

  let semantic: SemanticOptions | undefined;
  if (isEmbeddingsReady()) {
    const emb = await getEmbedding(text);
    if (emb) semantic = { queryEmbedding: emb, cosineThreshold: opts.cosineThreshold ?? COSINE_MATCH };
  }

  return findSimilarCards(text, existingCards, opts.jaccardThreshold ?? JACCARD_SIMILAR, semantic);
}
