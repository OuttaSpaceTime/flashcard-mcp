import { describe, it, expect, beforeEach } from "vitest";
import { createCard, deleteCard, deleteCards } from "../../src/core/card-service.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";

let deckId: string;

beforeEach(async () => {
  deckId = (await createDeck("Tombstones")).id;
});

async function seed(front: string): Promise<string> {
  const { card } = await createCard({ deckId, front, back: "an answer", skipPressureGate: true });
  return card.id;
}

async function tombstoned(): Promise<string[]> {
  const rows = await getDb().deletedCard.findMany({ select: { cardId: true } });
  return rows.map((r) => r.cardId).sort();
}

describe("deletion tombstones", () => {
  it("records the id when a card is deleted", async () => {
    const id = await seed("one question?");

    await deleteCard(id);

    expect(await tombstoned()).toEqual([id]);
    expect(await getDb().card.findUnique({ where: { id } })).toBeNull();
  });

  it("records every id in a bulk delete", async () => {
    const ids = [await seed("first?"), await seed("second?")];

    await deleteCards(ids);

    expect(await tombstoned()).toEqual([...ids].sort());
  });

  it("survives deleting the same id twice", async () => {
    const id = await seed("asked once?");
    await deleteCard(id);

    await getDb().card.create({ data: { id, deckId, front: "again?", back: "b" } });
    await deleteCard(id);

    expect(await tombstoned()).toEqual([id]);
  });

  it("leaves no tombstone for a card that was never deleted", async () => {
    await seed("still here?");

    expect(await tombstoned()).toEqual([]);
  });
});
