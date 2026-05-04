import { getDb } from "../db/client.js";
import type { DeckStats } from "./types.js";
import { State } from "ts-fsrs";

export async function createDeck(name: string, description?: string) {
  const db = getDb();
  return db.deck.create({
    data: { name, description: description ?? null },
  });
}

export async function listDecks(): Promise<
  Array<{ id: string; name: string; description: string | null; totalCards: number }>
> {
  const db = getDb();
  const decks = await db.deck.findMany({
    include: { _count: { select: { cards: true } } },
    orderBy: { name: "asc" },
  });

  return decks.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    totalCards: d._count.cards,
  }));
}

export async function getDeckStats(deckId: string): Promise<DeckStats> {
  const db = getDb();
  const now = new Date();

  const [deck, totalCards, dueCards, stateCounts, dueStateCounts] = await Promise.all([
    db.deck.findUnique({ where: { id: deckId } }),
    db.card.count({ where: { deckId } }),
    db.card.count({ where: { deckId, due: { lte: now }, suspended: false } }),
    db.card.groupBy({ by: ["state"], where: { deckId }, _count: { _all: true } }),
    db.card.groupBy({
      by: ["state"],
      where: { deckId, due: { lte: now }, suspended: false },
      _count: { _all: true },
    }),
  ]);

  if (!deck) throw new Error(`Deck not found: ${deckId}`);

  const countByState = (state: State) =>
    stateCounts.find((r) => r.state === state)?._count._all ?? 0;
  const dueByState = (state: State) =>
    dueStateCounts.find((r) => r.state === state)?._count._all ?? 0;

  return {
    id: deck.id,
    name: deck.name,
    description: deck.description,
    totalCards,
    dueCards,
    newCards: countByState(State.New),
    learningCards: countByState(State.Learning),
    reviewCards: countByState(State.Review),
    relearningCards: countByState(State.Relearning),
    dueNew: dueByState(State.New),
    dueLearning: dueByState(State.Learning),
    dueReview: dueByState(State.Review),
    dueRelearning: dueByState(State.Relearning),
  };
}

export async function deleteDeck(deckId: string): Promise<{ deletedCards: number }> {
  const db = getDb();
  const deck = await db.deck.findUnique({
    where: { id: deckId },
    include: { _count: { select: { cards: true } } },
  });
  if (!deck) throw new Error(`Deck not found: ${deckId}`);
  await db.deck.delete({ where: { id: deckId } });
  return { deletedCards: deck._count.cards };
}

export async function getDeckByName(name: string) {
  const db = getDb();
  return db.deck.findUnique({ where: { name } });
}

export async function getOrCreateDeck(name: string, description?: string) {
  const db = getDb();
  return db.deck.upsert({
    where: { name },
    create: { name, description: description ?? null },
    update: {},
  });
}
