import { getDb } from "../db/client.js";
import { getRetrievability, toSchedulableCard } from "./scheduler.js";
import { State } from "ts-fsrs";
import type { CardMaturity } from "./types.js";

export async function getStudyStreak(): Promise<number> {
  const db = getDb();
  const sessions = await db.studySession.findMany({
    where: { cardsReviewed: { gt: 0 } },
    orderBy: { startTime: "desc" },
    select: { startTime: true },
  });

  if (sessions.length === 0) return 0;

  const days = new Set(
    sessions.map((s) => s.startTime.toISOString().split("T")[0])
  );

  const toDateStr = (d: Date) => d.toISOString().split("T")[0]!;
  let streak = 0;
  const checkDate = new Date();
  while (days.has(toDateStr(checkDate))) {
    streak++;
    checkDate.setDate(checkDate.getDate() - 1);
  }

  return streak;
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
    include: { cards: { select: { maturity: true } } },
  });

  return decks
    .filter((d) => d.cards.length > 0)
    .map((deck) => {
      const counts = { new: 0, learning: 0, familiar: 0, internalized: 0 };
      for (const card of deck.cards) {
        const m = card.maturity as CardMaturity;
        if (m in counts) counts[m]++;
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
