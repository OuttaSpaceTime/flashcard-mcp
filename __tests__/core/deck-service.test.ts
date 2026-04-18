import { describe, it, expect } from "vitest";
import {
  createDeck,
  listDecks,
  getDeckStats,
  deleteDeck,
} from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";

describe("deck-service", () => {
  describe("createDeck", () => {
    it("creates a deck with name and description", async () => {
      const deck = await createDeck("React", "React fundamentals");
      expect(deck.name).toBe("React");
      expect(deck.description).toBe("React fundamentals");
      expect(deck.id).toBeDefined();
    });

    it("throws on duplicate name", async () => {
      await createDeck("React");
      await expect(createDeck("React")).rejects.toThrow();
    });

    it("creates deck without description", async () => {
      const deck = await createDeck("TypeScript");
      expect(deck.name).toBe("TypeScript");
      expect(deck.description).toBeNull();
    });
  });

  describe("listDecks", () => {
    it("returns empty array when no decks", async () => {
      const decks = await listDecks();
      expect(decks).toEqual([]);
    });

    it("returns all decks with card counts", async () => {
      const deck = await createDeck("React");
      const db = getDb();
      await db.card.create({
        data: {
          deckId: deck.id,
          front: "What is JSX?",
          back: "A syntax extension for JavaScript",
        },
      });

      const decks = await listDecks();
      expect(decks.length).toBe(1);
      expect(decks[0].name).toBe("React");
      expect(decks[0].totalCards).toBe(1);
    });
  });

  describe("getDeckStats", () => {
    it("returns stats with card state breakdown", async () => {
      const deck = await createDeck("React");
      const db = getDb();

      // Create cards in different states
      await db.card.create({
        data: {
          deckId: deck.id,
          front: "Q1",
          back: "A1",
          state: 0, // New
        },
      });
      await db.card.create({
        data: {
          deckId: deck.id,
          front: "Q2",
          back: "A2",
          state: 1, // Learning
        },
      });
      await db.card.create({
        data: {
          deckId: deck.id,
          front: "Q3",
          back: "A3",
          state: 2, // Review
        },
      });

      const stats = await getDeckStats(deck.id);
      expect(stats.totalCards).toBe(3);
      expect(stats.newCards).toBe(1);
      expect(stats.learningCards).toBe(1);
      expect(stats.reviewCards).toBe(1);
      expect(stats.relearningCards).toBe(0);
    });

    it("throws when deck does not exist", async () => {
      await expect(getDeckStats("nonexistent-id")).rejects.toThrow("Deck not found: nonexistent-id");
    });

    it("counts due cards correctly", async () => {
      const deck = await createDeck("React");
      const db = getDb();

      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await db.card.create({
        data: { deckId: deck.id, front: "Q1", back: "A1", due: past },
      });
      await db.card.create({
        data: { deckId: deck.id, front: "Q2", back: "A2", due: future },
      });

      const stats = await getDeckStats(deck.id);
      expect(stats.dueCards).toBe(1);
    });
  });

  describe("deleteDeck", () => {
    it("removes the deck", async () => {
      const deck = await createDeck("React");
      const result = await deleteDeck(deck.id);
      expect(result.deletedCards).toBe(0);
      expect(await listDecks()).toEqual([]);
    });

    it("cascades and deletes cards in the deck", async () => {
      const deck = await createDeck("React");
      const db = getDb();
      await db.card.create({ data: { deckId: deck.id, front: "Q1", back: "A1" } });
      await db.card.create({ data: { deckId: deck.id, front: "Q2", back: "A2" } });

      const result = await deleteDeck(deck.id);
      expect(result.deletedCards).toBe(2);
      expect(await db.card.count({ where: { deckId: deck.id } })).toBe(0);
    });

    it("throws when deck does not exist", async () => {
      await expect(deleteDeck("nonexistent-id")).rejects.toThrow("Deck not found: nonexistent-id");
    });
  });
});
