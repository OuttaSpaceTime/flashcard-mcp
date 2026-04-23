import { getDb } from "../db/client.js";
import { createNewFsrsCard } from "./scheduler.js";
import {
  checkDuplicate,
  findSimilarCards,
  getEmbedding,
  isEmbeddingsReady,
  type CardForSimilarity,
  type SemanticOptions,
} from "./embeddings.js";
import { parseTags, serializeTags } from "./types.js";
import type { CardMaturity, CardType, DuplicateCheckResult } from "./types.js";
import type { Card as PrismaCard } from "@prisma/client";

interface CreateCardInput {
  deckId: string;
  front: string;
  back: string;
  tags?: string[];
  type?: CardType;
  category?: string | null;
  source?: string;
  checkDuplicates?: boolean;
}

interface CreateCardResult {
  card: PrismaCard;
  duplicateWarning?: DuplicateCheckResult;
}

function cardEmbeddingText(front: string, back: string): string {
  return `${front} ${back}`;
}

function applyCategoryFilter(where: Record<string, unknown>, cat: string | undefined): void {
  if (cat === "__uncategorized__") where.category = null;
  else if (cat === "__any__") where.category = { not: null };
  else if (cat != null && cat !== "") where.category = cat;
}

export const CARD_STATE_BY_NAME: Record<string, number> = {
  new: 0,
  learning: 1,
  review: 2,
  relearning: 3,
};

export type CardStateName = keyof typeof CARD_STATE_BY_NAME;

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
  const db = getDb();
  const fsrsDefaults = createNewFsrsCard();

  let duplicateWarning: DuplicateCheckResult | undefined;

  if (input.checkDuplicates) {
    const existingCards = await db.card.findMany({
      where: { deckId: input.deckId },
      select: { id: true, front: true, embedding: true },
    });

    const cardsSim: CardForSimilarity[] = existingCards.map((c) => ({
      id: c.id,
      front: c.front,
      embedding: c.embedding,
    }));

    // Build semantic options if embeddings are loaded
    let semantic: SemanticOptions | undefined;
    if (isEmbeddingsReady()) {
      const queryEmb = await getEmbedding(cardEmbeddingText(input.front, input.back));
      if (queryEmb) {
        semantic = { queryEmbedding: queryEmb, cosineThreshold: 0.45 };
      }
    }

    const dupResult = checkDuplicate(input.front, cardsSim, 0.85, 0.65, semantic);
    if (dupResult.isDuplicate || dupResult.similarCards.length > 0) {
      duplicateWarning = {
        isDuplicate: dupResult.isDuplicate,
        reason: dupResult.reason,
        similarCards: dupResult.similarCards,
      };
    }
  }

  const card = await db.card.create({
    data: {
      deckId: input.deckId,
      front: input.front,
      back: input.back,
      tags: serializeTags(input.tags),
      type: input.type ?? "guided",
      category: input.category ?? null,
      source: input.source ?? null,
      due: fsrsDefaults.due,
      stability: fsrsDefaults.stability,
      difficulty: fsrsDefaults.difficulty,
      reps: fsrsDefaults.reps,
      lapses: fsrsDefaults.lapses,
      state: fsrsDefaults.state,
      lastReview: fsrsDefaults.lastReview,
      interval: fsrsDefaults.interval,
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

export async function getCard(id: string): Promise<PrismaCard | null> {
  const db = getDb();
  return db.card.findUnique({ where: { id } });
}

export async function updateCard(
  id: string,
  updates: {
    front?: string;
    back?: string;
    tags?: string;
    category?: string | null;
    source?: string;
  }
): Promise<PrismaCard> {
  const db = getDb();
  const updated = await db.card.update({ where: { id }, data: updates });

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

export async function deleteCard(id: string): Promise<void> {
  const db = getDb();
  await db.card.delete({ where: { id } });
}

export async function deleteCards(ids: string[]): Promise<{ deleted: number }> {
  if (ids.length === 0) return { deleted: 0 };
  const db = getDb();
  const res = await db.card.deleteMany({ where: { id: { in: ids } } });
  return { deleted: res.count };
}

export async function listCards(filters: {
  deckId?: string;
  tagFilter?: "empty" | "has_any" | string;
  category?: string;
  state?: CardStateName | string;
  limit?: number;
  offset?: number;
}): Promise<PrismaCard[]> {
  const db = getDb();
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
  const offset = Math.max(0, filters.offset ?? 0);

  const where: Record<string, unknown> = {};
  if (filters.deckId != null && filters.deckId !== "") {
    where.deckId = filters.deckId;
  }

  if (filters.state != null && filters.state !== "") {
    if (!Object.prototype.hasOwnProperty.call(CARD_STATE_BY_NAME, filters.state)) {
      throw new Error(
        `Invalid state "${filters.state}". Expected one of: ${Object.keys(CARD_STATE_BY_NAME).join(", ")}`
      );
    }
    where.state = CARD_STATE_BY_NAME[filters.state];
  }

  applyCategoryFilter(where, filters.category);

  const tf = filters.tagFilter;
  const isExactTag = tf != null && tf !== "" && tf !== "empty" && tf !== "has_any";

  if (tf === "empty") where.tags = "";
  else if (tf === "has_any") where.tags = { not: "" };
  else if (isExactTag) where.tags = { contains: tf };

  if (isExactTag) {
    // `contains` can false-positive ("foo" inside "foobar"), so post-filter in JS.
    // Over-fetch a bounded pool rather than loading every substring match.
    const candidates = await db.card.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: (offset + limit) * 4,
    });
    const matched = candidates.filter((c) => parseTags(c.tags).includes(tf));
    return matched.slice(offset, offset + limit);
  }

  return db.card.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: offset,
    take: limit,
  });
}

export async function searchCards(
  query: string,
  filters?: {
    deckId?: string;
    tags?: string[];
    category?: string;
    state?: number;
    maturity?: CardMaturity;
  }
): Promise<PrismaCard[]> {
  const db = getDb();

  const where: Record<string, unknown> = {};

  if (query !== "") {
    where.OR = [
      { front: { contains: query } },
      { back: { contains: query } },
    ];
  }

  if (filters?.deckId) {
    where.deckId = filters.deckId;
  }

  if (filters?.tags && filters.tags.length > 0) {
    where.AND = filters.tags.map((tag) => ({
      tags: { contains: tag },
    }));
  }

  if (filters?.state !== undefined) {
    where.state = filters.state;
  }

  if (filters?.maturity != null) {
    where.maturity = filters.maturity;
  }

  applyCategoryFilter(where, filters?.category);

  return db.card.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 });
}

export async function getDueCards(limit: number = 30) {
  const db = getDb();
  return db.card.findMany({
    where: { due: { lte: new Date() }, suspended: false },
    include: { deck: { select: { name: true } } },
    take: limit,
    orderBy: { due: "asc" },
  });
}

export async function findSimilar(
  text: string,
  opts?: { deckId?: string; jaccardThreshold?: number; cosineThreshold?: number }
) {
  const db = getDb();
  const where: Record<string, unknown> = {};
  if (opts?.deckId) where.deckId = opts.deckId;

  const existingCards = await db.card.findMany({
    where,
    select: { id: true, front: true, embedding: true },
  });

  let semantic: SemanticOptions | undefined;
  if (isEmbeddingsReady()) {
    const emb = await getEmbedding(text);
    if (emb) {
      semantic = {
        queryEmbedding: emb,
        cosineThreshold: opts?.cosineThreshold ?? 0.45,
      };
    }
  }

  return findSimilarCards(
    text,
    existingCards,
    opts?.jaccardThreshold ?? 0.50,
    semantic
  );
}
