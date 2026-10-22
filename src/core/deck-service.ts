import type { Deck } from "@prisma/client";
import { State } from "ts-fsrs";
import { getDb } from "../db/client.js";
import { tombstone } from "./card-service.js";
import type { DeckStats } from "./types.js";

export async function createDeck(name: string, description?: string) {
  const db = getDb();
  return db.deck.create({
    data: { name, description: description ?? null },
  });
}

/** Deck id -> name. A handful of decks, so one query beats a join per card. */
export async function deckNames(): Promise<Map<string, string>> {
  const decks = await getDb().deck.findMany({ select: { id: true, name: true } });
  return new Map(decks.map((d) => [d.id, d.name]));
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

interface StateCount {
  deckId: string;
  state: number;
  _count: { _all: number };
}

/** Card counts by deck and state, all and due now, for `deckIds` (default every deck). */
async function stateCounts(deckIds?: string[]): Promise<[StateCount[], StateCount[]]> {
  const db = getDb();
  const scope = deckIds != null ? { deckId: { in: deckIds } } : {};
  return Promise.all([
    db.card.groupBy({ by: ["deckId", "state"], where: scope, _count: { _all: true } }),
    db.card.groupBy({
      by: ["deckId", "state"],
      where: { ...scope, due: { lte: new Date() }, suspended: false },
      _count: { _all: true },
    }),
  ]);
}

function toDeckStats(deck: Deck, all: StateCount[], due: StateCount[]): DeckStats {
  const count = (rows: StateCount[], state?: State): number =>
    rows
      .filter((r) => r.deckId === deck.id && (state === undefined || r.state === state))
      .reduce((n, r) => n + r._count._all, 0);
  return {
    id: deck.id,
    name: deck.name,
    description: deck.description,
    totalCards: count(all),
    dueCards: count(due),
    newCards: count(all, State.New),
    learningCards: count(all, State.Learning),
    reviewCards: count(all, State.Review),
    relearningCards: count(all, State.Relearning),
    dueNew: count(due, State.New),
    dueLearning: count(due, State.Learning),
    dueReview: count(due, State.Review),
    dueRelearning: count(due, State.Relearning),
  };
}

export async function getDeckStats(deckId: string): Promise<DeckStats> {
  const db = getDb();
  const [deck, [all, due]] = await Promise.all([
    db.deck.findUnique({ where: { id: deckId } }),
    stateCounts([deckId]),
  ]);
  if (!deck) throw new Error(`Deck not found: ${deckId}`);
  return toDeckStats(deck, all, due);
}

/** Stats for every deck, by name, in three queries whatever the deck count. */
export async function listDeckStats(): Promise<DeckStats[]> {
  const db = getDb();
  const [decks, [all, due]] = await Promise.all([
    db.deck.findMany({ orderBy: { name: "asc" } }),
    stateCounts(),
  ]);
  return decks.map((deck) => toDeckStats(deck, all, due));
}

export async function deleteDeck(deckId: string): Promise<{ deletedCards: number }> {
  const db = getDb();
  const deck = await db.deck.findUnique({ where: { id: deckId }, select: { id: true } });
  if (!deck) throw new Error(`Deck not found: ${deckId}`);
  return db.$transaction(async (tx) => {
    const ids = (await tx.card.findMany({ where: { deckId }, select: { id: true } })).map((c) => c.id);
    await tombstone(tx, ids);
    await tx.deck.delete({ where: { id: deckId } });
    return { deletedCards: ids.length };
  });
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
