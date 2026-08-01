import { getDb } from "../db/client.js";
import type { Card as PrismaCard } from "@prisma/client";

/**
 * Leeches — cards whose repeated failure means the card is the problem.
 *
 * This is enforcement, not a report. A list of leech candidates is easy to
 * ignore; the study loop instead stops on the card that keeps failing and
 * refuses to advance until it has been rewritten, split, dropped, or explicitly
 * kept. Same shape as the SRS pressure gate: the server refuses, and the error
 * message is the whole UX.
 */

export const LEECH_LAPSES = 5;

export interface LeechFlag {
  lapses: number;
  mustResolve: true;
}

type LeechState = Pick<PrismaCard, "id" | "lapses" | "leechFlaggedAt" | "leechDeferredLapses">;

/**
 * A flag the developer has not answered yet. A deferred card counts as answered
 * until it fails again — deferring means "this wording is fine", which the next
 * lapse disproves.
 */
export function isUnresolvedLeech(card: LeechState): boolean {
  if (card.leechFlaggedAt == null) return false;
  return card.leechDeferredLapses == null || card.lapses > card.leechDeferredLapses;
}

/** The `leech` field a served card carries, or null when it is not a leech. */
export function leechPayload(card: LeechState): LeechFlag | null {
  return isUnresolvedLeech(card) ? { lapses: card.lapses, mustResolve: true } : null;
}

/**
 * Stamp a served card that is at or over the threshold. Suspended cards are
 * skipped: they keep their lapse count but are not in review, so stopping the
 * session over one fixes nothing the developer is about to hit.
 */
export async function flagLeechOnServe(card: PrismaCard): Promise<PrismaCard> {
  if (card.suspended || card.lapses < LEECH_LAPSES) return card;
  if (card.leechDeferredLapses != null && card.lapses <= card.leechDeferredLapses) return card;

  return getDb().card.update({
    where: { id: card.id },
    data: { leechFlaggedAt: new Date() },
  });
}

/**
 * Card fields that retire a flag. A rewrite is the resolution, so the failure
 * history goes with it: those lapses were earned by the old wording, and
 * carrying them over would re-flag the new card almost immediately. The deferral
 * is cleared too, or a later flag would need one lapse more than it should.
 */
const LEECH_RESOLVED = { leechFlaggedAt: null, leechDeferredLapses: null, lapses: 0 };

/** The clearing fields when `id` is flagged, nothing when it is not. */
export async function leechResolutionFor(id: string): Promise<Partial<typeof LEECH_RESOLVED>> {
  const card = await getDb().card.findUnique({
    where: { id },
    select: { leechFlaggedAt: true },
  });
  return card?.leechFlaggedAt != null ? LEECH_RESOLVED : {};
}

/** Throws while any card carries a flag the developer has not answered. */
export async function assertNoUnresolvedLeech(): Promise<void> {
  const db = getDb();
  const flagged = await db.card.findMany({
    where: { leechFlaggedAt: { not: null } },
    select: { id: true, lapses: true, leechFlaggedAt: true, leechDeferredLapses: true },
  });
  const unresolved = flagged.filter(isUnresolvedLeech);
  if (unresolved.length === 0) return;

  const blocks = unresolved.map(
    (card) =>
      `Card ${card.id} has lapsed ${card.lapses} times (leech at ${LEECH_LAPSES}). Pick one:
- update_card(cardId: "${card.id}", front/back: ...) — rewrite it; this clears the flag and resets its lapse count to 0
- create_card(..., inheritFrom: "${card.id}") for each half, then delete_card(cardId: "${card.id}") — split it, keeping the schedule
- delete_card(cardId: "${card.id}") — drop the card
- resolve_leech(cardId: "${card.id}", action: "defer") — keep it as it is; it flags again on the next lapse`
  );

  throw new Error(`Study blocked: a card keeps failing and needs a decision.\n${blocks.join("\n\n")}`);
}

/**
 * Keep a flagged card as it is. The lapse count it was flagged at is recorded,
 * so the same card stops blocking now and flags again the next time it fails.
 */
export async function deferLeech(cardId: string): Promise<PrismaCard> {
  const db = getDb();
  const card = await db.card.findUnique({ where: { id: cardId } });
  if (card == null) throw new Error(`Card not found: ${cardId}`);

  return db.card.update({
    where: { id: cardId },
    data: { leechDeferredLapses: card.lapses },
  });
}
