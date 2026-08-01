import { describe, it, expect, beforeEach } from "vitest";
import { LEECH_LAPSES, leechPayload, deferLeech } from "../../src/core/leeches.js";
import { createCard, updateCard, deleteCard } from "../../src/core/card-service.js";
import { createDeck } from "../../src/core/deck-service.js";
import { startSession, getNextCard } from "../../src/core/session-service.js";
import { getDb } from "../../src/db/client.js";
import { State } from "ts-fsrs";

let deckId: string;

const pastDue = (): Date => new Date(Date.now() - 60_000);

async function seedCard(
  lapses: number,
  data: { suspended?: boolean; leechDeferredLapses?: number } = {}
): Promise<string> {
  const card = await getDb().card.create({
    data: {
      deckId,
      front: `card ${Math.random()}`,
      back: "a",
      state: State.Review,
      due: pastDue(),
      stability: 5,
      difficulty: 6,
      reps: 10,
      interval: 4,
      lapses,
      suspended: data.suspended ?? false,
      leechDeferredLapses: data.leechDeferredLapses ?? null,
    },
  });
  return card.id;
}

/** Serve one card from a fresh session, returning it with its leech payload. */
async function serve(): Promise<{ id: string; leech: ReturnType<typeof leechPayload> }> {
  const session = await startSession();
  const card = await getNextCard(session.id);
  if (card == null) throw new Error("expected a card to be served");
  return { id: card.id, leech: leechPayload(card) };
}

async function flaggedAt(cardId: string): Promise<Date | null> {
  const card = await getDb().card.findUnique({ where: { id: cardId } });
  return card?.leechFlaggedAt ?? null;
}

describe("leeches", () => {
  beforeEach(async () => {
    const deck = await createDeck("LeechDeck");
    deckId = deck.id;
  });

  describe("flag on serve", () => {
    it("leaves a card one lapse below the threshold alone", async () => {
      const id = await seedCard(LEECH_LAPSES - 1);
      const served = await serve();
      expect(served.leech).toBeNull();
      expect(await flaggedAt(id)).toBeNull();
    });

    it("flags a card exactly at the threshold", async () => {
      const id = await seedCard(LEECH_LAPSES);
      const served = await serve();
      expect(served.leech).toEqual({ lapses: LEECH_LAPSES, mustResolve: true });
      expect(await flaggedAt(id)).toBeInstanceOf(Date);
    });

    it("flags a card above the threshold", async () => {
      const id = await seedCard(LEECH_LAPSES + 1);
      const served = await serve();
      expect(served.leech).toEqual({ lapses: LEECH_LAPSES + 1, mustResolve: true });
      expect(await flaggedAt(id)).toBeInstanceOf(Date);
    });

    it("never flags a suspended card", async () => {
      const id = await seedCard(LEECH_LAPSES + 3);
      const session = await startSession();
      await getDb().card.update({ where: { id }, data: { suspended: true } });

      const card = await getNextCard(session.id);
      expect(leechPayload(card!)).toBeNull();
      expect(await flaggedAt(id)).toBeNull();
    });
  });

  describe("block on advance", () => {
    it("throws on the next get_next_card while a flag is unresolved", async () => {
      const id = await seedCard(LEECH_LAPSES + 2);
      const session = await startSession();
      await getNextCard(session.id);

      await expect(getNextCard(session.id)).rejects.toThrow(new RegExp(id));
      await expect(getNextCard(session.id)).rejects.toThrow(/7 times/);
    });

    it("names every way out in the message", async () => {
      await seedCard(LEECH_LAPSES);
      const session = await startSession();
      await getNextCard(session.id);

      await expect(getNextCard(session.id)).rejects.toThrow(/update_card/);
      await expect(getNextCard(session.id)).rejects.toThrow(/inheritFrom/);
      await expect(getNextCard(session.id)).rejects.toThrow(/delete_card/);
      await expect(getNextCard(session.id)).rejects.toThrow(/resolve_leech/);
    });

    it("blocks a session started after the flag, too", async () => {
      await seedCard(LEECH_LAPSES);
      const first = await startSession();
      await getNextCard(first.id);

      const second = await startSession();
      await expect(getNextCard(second.id)).rejects.toThrow(/blocked/);
    });

    it("does not block while every card is below the threshold", async () => {
      await seedCard(LEECH_LAPSES - 1);
      await seedCard(0);
      const session = await startSession();

      expect(await getNextCard(session.id)).not.toBeNull();
      expect(await getNextCard(session.id)).not.toBeNull();
    });
  });

  describe("resolution clears the block", () => {
    it("update_card clears the flag and resets the lapse count", async () => {
      const id = await seedCard(LEECH_LAPSES + 1);
      const session = await startSession();
      await getNextCard(session.id);

      const updated = await updateCard(id, { front: "a sharper question" });
      expect(updated.leechFlaggedAt).toBeNull();
      expect(updated.lapses).toBe(0);

      await expect(getNextCard(session.id)).resolves.not.toThrow();
    });

    it("update_card leaves an unflagged card's lapses alone", async () => {
      const id = await seedCard(3);
      const updated = await updateCard(id, { front: "just a tweak" });
      expect(updated.lapses).toBe(3);
    });

    it("delete_card clears the block", async () => {
      const id = await seedCard(LEECH_LAPSES);
      const session = await startSession();
      await getNextCard(session.id);

      await deleteCard(id);
      await expect(getNextCard(session.id)).resolves.not.toThrow();
    });

    it("splitting via inheritFrom and deleting the original clears the block", async () => {
      const id = await seedCard(LEECH_LAPSES);
      const session = await startSession();
      await getNextCard(session.id);

      const { card: split } = await createCard({
        deckId,
        front: "half the original",
        back: "a",
        inheritFrom: id,
      });
      await deleteCard(id);

      expect(split.leechFlaggedAt).toBeNull();
      expect(split.lapses).toBe(0);
      await expect(getNextCard(session.id)).resolves.not.toThrow();
    });

    it("resolve_leech defer clears the block and records the lapse count", async () => {
      const id = await seedCard(LEECH_LAPSES);
      const session = await startSession();
      await getNextCard(session.id);

      const deferred = await deferLeech(id);
      expect(deferred.leechDeferredLapses).toBe(LEECH_LAPSES);

      await expect(getNextCard(session.id)).resolves.not.toThrow();
    });
  });

  describe("a deferred card is deferred until it fails again", () => {
    it("does not flag or block again at the same lapse count", async () => {
      const id = await seedCard(LEECH_LAPSES, { leechDeferredLapses: LEECH_LAPSES });

      const served = await serve();
      expect(served.leech).toBeNull();
      expect(await flaggedAt(id)).toBeNull();
    });

    it("flags and blocks again after one more lapse", async () => {
      const id = await seedCard(LEECH_LAPSES + 1, { leechDeferredLapses: LEECH_LAPSES });
      const session = await startSession();

      const card = await getNextCard(session.id);
      expect(leechPayload(card!)).toEqual({ lapses: LEECH_LAPSES + 1, mustResolve: true });
      await expect(getNextCard(session.id)).rejects.toThrow(/blocked/);
    });
  });

  describe("inheritFrom", () => {
    it("does not copy the flag or the lapse count off a flagged parent", async () => {
      const id = await seedCard(LEECH_LAPSES + 4);
      const session = await startSession();
      await getNextCard(session.id);

      const { card } = await createCard({
        deckId,
        front: "derived from a leech",
        back: "a",
        inheritFrom: id,
      });

      expect(card.leechFlaggedAt).toBeNull();
      expect(card.leechDeferredLapses).toBeNull();
      expect(card.lapses).toBe(0);
      expect(card.stability).toBe(5);
    });
  });
});
