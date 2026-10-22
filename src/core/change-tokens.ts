import { getDb } from "../db/client.js";

/**
 * Tokens that change whenever a table's rows do, written by this process or
 * any other on the same database (Claude Code's MCP server, the CLI, the app
 * server). The Omvida app polls them to notice outside changes without
 * reloading everything every few seconds.
 *
 * Each token is the row count plus the newest timestamp: an insert or edit
 * moves the max, a delete moves the count. Not `PRAGMA data_version`, which
 * would skip our own writes but is per connection, and the Prisma adapter owns
 * those.
 *
 * - `cards`: count and newest `updatedAt`. A review does not move it: it
 *   writes the card's scheduling and keeps its updatedAt (session-service.ts),
 *   so mid-session the app reloads the deck for a card fixed in Claude Code,
 *   not for every rating.
 * - `reviews`: count and newest `reviewedAt`. Reviews, from the app or a
 *   /study chat, move the due counts and the cards' scheduling.
 * - `notes`: count and newest `updatedAt` of the card notes, apart from the
 *   cards so a saved note reloads only the notes; a resolved note (a delete)
 *   shows as surely as the card it fixed.
 */
export interface ChangeTokens {
  cards: string;
  reviews: string;
  notes: string;
}

function changeToken(count: number, newest: Date | null): string {
  return `${count}:${newest?.getTime() ?? 0}`;
}

export async function changeTokens(): Promise<ChangeTokens> {
  const db = getDb();
  const [cards, reviews, notes] = await Promise.all([
    db.card.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    db.review.aggregate({ _count: { _all: true }, _max: { reviewedAt: true } }),
    db.cardNote.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
  ]);
  return {
    cards: changeToken(cards._count._all, cards._max.updatedAt),
    reviews: changeToken(reviews._count._all, reviews._max.reviewedAt),
    notes: changeToken(notes._count._all, notes._max.updatedAt),
  };
}
