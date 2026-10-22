import type { CardNote } from "@prisma/client";
import { getDb } from "../db/client.js";

/**
 * Card notes: what the developer wants done about a card, written mid-study so
 * the session goes on (Omvida's Ctrl+N), and handled later in one fix session
 * (Omvida's "Fix all", which hands every note to Claude Code). A note is an
 * edit to make, something to understand better, or anything else; it is free
 * markdown, and the fix session reads it and decides. One per card: noting a
 * card again edits its note.
 *
 * Nothing here changes the card. The fix session edits it with update_card (or
 * splits it) as for any other fix, then resolves the note, which deletes it.
 */

/** Writes the card's note; an empty body deletes it. Returns the note, or null once gone. */
export async function setCardNote(cardId: string, body: string): Promise<CardNote | null> {
  const db = getDb();
  const text = body.trim();
  if (text === "") {
    await resolveCardNote(cardId);
    return null;
  }
  const card = await db.card.findUnique({ where: { id: cardId }, select: { id: true } });
  if (card == null) throw new Error(`Card not found: ${cardId}`);
  return db.cardNote.upsert({
    where: { cardId },
    create: { cardId, body: text },
    update: { body: text },
  });
}

/** The card fields a note's reader shows beside it. */
export interface NotedCard {
  front: string;
  back: string;
  tags: string;
  lapses: number;
  deck: { name: string };
}

/** Every open note with its card, oldest first: the order they were noted in. */
export async function listCardNotes(): Promise<(CardNote & { card: NotedCard })[]> {
  return getDb().cardNote.findMany({
    include: {
      card: {
        select: { front: true, back: true, tags: true, lapses: true, deck: { select: { name: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Deletes the card's note. True when there was one. */
export async function resolveCardNote(cardId: string): Promise<boolean> {
  const res = await getDb().cardNote.deleteMany({ where: { cardId } });
  return res.count > 0;
}
