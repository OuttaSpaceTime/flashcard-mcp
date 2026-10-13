import { describe, it, expect, beforeEach } from "vitest";
import { createDeck } from "../../src/core/deck-service.js";
import { createCard, deleteCard, getCard } from "../../src/core/card-service.js";
import { listCardNotes, resolveCardNote, setCardNote } from "../../src/core/card-notes.js";

let deckId: string;

describe("card notes", () => {
  beforeEach(async () => {
    deckId = (await createDeck("Rails")).id;
  });

  it("keeps one note per card: noting it again edits the note", async () => {
    const { card } = await createCard({ deckId, front: "What does with_lock do?", back: "SELECT ... FOR UPDATE" });
    await setCardNote(card.id, "  The back should say it reloads the row.  ");
    await setCardNote(card.id, "Explain **why** it reloads.");
    const notes = await listCardNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("Explain **why** it reloads.");
    expect(notes[0].card.front).toBe("What does with_lock do?");
    expect(notes[0].card.deck.name).toBe("Rails");
  });

  it("does not touch the card it notes", async () => {
    const { card } = await createCard({ deckId, front: "Q", back: "A" });
    const before = (await getCard(card.id))!.updatedAt.getTime();
    await setCardNote(card.id, "split this");
    expect((await getCard(card.id))!.updatedAt.getTime()).toBe(before);
  });

  it("an empty note deletes it, and resolving deletes it", async () => {
    const { card: a } = await createCard({ deckId, front: "Q1", back: "A1" });
    const { card: b } = await createCard({ deckId, front: "Q2", back: "A2" });
    await setCardNote(a.id, "x");
    await setCardNote(b.id, "y");
    expect(await setCardNote(a.id, "   ")).toBeNull();
    expect((await listCardNotes()).map((n) => n.cardId)).toEqual([b.id]);
    expect(await resolveCardNote(b.id)).toBe(true);
    expect(await resolveCardNote(b.id)).toBe(false);
    expect(await listCardNotes()).toHaveLength(0);
  });

  it("goes with its card", async () => {
    const { card } = await createCard({ deckId, front: "Q", back: "A" });
    await setCardNote(card.id, "reword");
    await deleteCard(card.id);
    expect(await listCardNotes()).toHaveLength(0);
  });

  it("refuses a card that does not exist", async () => {
    await expect(setCardNote("nope", "x")).rejects.toThrow("Card not found");
  });
});
