import { getDb } from "../db/client.js";
import { cardMaturity, getRetrievability, toSchedulableCard } from "./scheduler.js";
import { State } from "ts-fsrs";
import { localDay, startOfLocalDay } from "./days.js";

/**
 * Consecutive local days (days.ts), ending today, with at least one review.
 * Counted from the reviews themselves rather than sessions, so a session that
 * runs past midnight credits both days, as the overview's week does. Reads the
 * last month of reviews, and a window twice as long only while the streak
 * fills the window it has.
 */
export async function getStudyStreak(now: Date = new Date()): Promise<number> {
  for (let span = 32; ; span *= 2) {
    const reviews = await getDb().review.findMany({
      where: { reviewedAt: { gte: startOfLocalDay(now, span - 1) } },
      select: { reviewedAt: true },
    });
    const days = new Set(reviews.map((r) => localDay(r.reviewedAt)));
    let streak = 0;
    while (streak < span && days.has(localDay(startOfLocalDay(now, streak)))) streak++;
    if (streak < span) return streak;
  }
}

/**
 * Card ids from the newest `limit` reviews, deduplicated, newest first, with
 * the local day each was last reviewed.
 */
export async function recentlyStudied(limit = 100): Promise<{ id: string; at: string }[]> {
  const newest = await getDb().review.findMany({
    select: { cardId: true, reviewedAt: true },
    orderBy: { reviewedAt: "desc" },
    take: limit,
  });
  const latest = new Map<string, Date>();
  for (const r of newest) if (!latest.has(r.cardId)) latest.set(r.cardId, r.reviewedAt);
  return [...latest].map(([id, at]) => ({ id, at: localDay(at) }));
}

export async function getRetentionByDeck(): Promise<
  Array<{
    deckId: string;
    deckName: string;
    cardCount: number;
    avgRetention: number;
  }>
> {
  const db = getDb();
  const decks = await db.deck.findMany({
    include: {
      cards: {
        select: {
          due: true, stability: true, difficulty: true,
          reps: true, lapses: true, state: true,
          lastReview: true, interval: true,
        },
      },
    },
  });

  return decks
    .filter((d) => d.cards.length > 0)
    .map((deck) => {
      const reviewCards = deck.cards.filter(
        (c) => c.state !== State.New && c.lastReview != null
      );

      let avgRetention = 0;
      if (reviewCards.length > 0) {
        const totalRetention = reviewCards.reduce((sum, card) => {
          return sum + getRetrievability(toSchedulableCard(card));
        }, 0);
        avgRetention = totalRetention / reviewCards.length;
      }

      return {
        deckId: deck.id,
        deckName: deck.name,
        cardCount: deck.cards.length,
        avgRetention,
      };
    });
}

export async function getMaturityReport(): Promise<
  Array<{
    deckId: string;
    deckName: string;
    new: number;
    learning: number;
    familiar: number;
    internalized: number;
    total: number;
  }>
> {
  const db = getDb();
  const decks = await db.deck.findMany({
    include: { cards: { select: { state: true, interval: true } } },
  });

  return decks
    .filter((d) => d.cards.length > 0)
    .map((deck) => {
      const counts = { new: 0, learning: 0, familiar: 0, internalized: 0 };
      for (const card of deck.cards) {
        counts[cardMaturity(card)]++;
      }
      return {
        deckId: deck.id,
        deckName: deck.name,
        ...counts,
        total: deck.cards.length,
      };
    });
}

export async function getLapsePatterns(): Promise<
  Array<{
    cardId: string;
    front: string;
    deckName: string;
    lapses: number;
  }>
> {
  const db = getDb();
  const cards = await db.card.findMany({
    where: { lapses: { gt: 0 } },
    include: { deck: { select: { name: true } } },
    orderBy: { lapses: "desc" },
    take: 20,
  });

  return cards.map((c) => ({
    cardId: c.id,
    front: c.front,
    deckName: c.deck.name,
    lapses: c.lapses,
  }));
}

export async function getSessionHistory(limit: number = 10) {
  const db = getDb();
  return db.studySession.findMany({
    orderBy: { startTime: "desc" },
    take: limit,
  });
}

export async function getFullStats() {
  const [streak, retention, maturity, lapses, recentSessions] =
    await Promise.all([
      getStudyStreak(),
      getRetentionByDeck(),
      getMaturityReport(),
      getLapsePatterns(),
      getSessionHistory(5),
    ]);
  return { streak, retention, maturity, lapses, recentSessions };
}
