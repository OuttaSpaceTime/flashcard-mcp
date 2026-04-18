import { describe, it, expect, beforeEach } from "vitest";
import {
  createCard,
  getCard,
  updateCard,
  deleteCard,
  suspendCard,
  unsuspendCard,
  searchCards,
} from "../../src/core/card-service.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";
import { State } from "ts-fsrs";

let testDeckId: string;

describe("card-service", () => {
  beforeEach(async () => {
    const deck = await createDeck("TestDeck");
    testDeckId = deck.id;
  });

  describe("createCard", () => {
    it("creates a card with correct FSRS defaults", async () => {
      const { card } = await createCard({
        deckId: testDeckId,
        front: "What is a closure?",
        back: "A function that captures variables from its enclosing scope",
      });

      expect(card.front).toBe("What is a closure?");
      expect(card.back).toBe(
        "A function that captures variables from its enclosing scope"
      );
      expect(card.state).toBe(State.New);
      expect(card.stability).toBe(0);
      expect(card.difficulty).toBe(0);
      expect(card.reps).toBe(0);
      expect(card.lapses).toBe(0);
      expect(card.maturity).toBe("new");
      expect(card.type).toBe("guided");
      expect(card.suspended).toBe(false);
    });

    it("creates a card with tags", async () => {
      const { card } = await createCard({
        deckId: testDeckId,
        front: "Q",
        back: "A",
        tags: ["javascript", "fundamentals"],
      });

      expect(card.tags).toBe("javascript,fundamentals");
    });

    it("creates an unguided card", async () => {
      const { card } = await createCard({
        deckId: testDeckId,
        front: "Build a todo app with React hooks",
        back: "Should use useState, useEffect, and useReducer",
        type: "unguided",
      });

      expect(card.type).toBe("unguided");
    });

    it("warns about duplicate cards (exact match)", async () => {
      await createCard({
        deckId: testDeckId,
        front: "What is a closure?",
        back: "A function with captured scope",
      });

      const result = await createCard({
        deckId: testDeckId,
        front: "What is a closure?",
        back: "Different answer",
        checkDuplicates: true,
      });

      expect(result.duplicateWarning).toBeDefined();
      expect(result.duplicateWarning!.isDuplicate).toBe(true);
    });

    it("creates card even with duplicate warning when not blocked", async () => {
      await createCard({
        deckId: testDeckId,
        front: "What is a closure?",
        back: "A function with captured scope",
      });

      const result = await createCard({
        deckId: testDeckId,
        front: "What is a closure?",
        back: "Different answer",
        checkDuplicates: true,
      });

      // Card is still created (warning only, not blocked)
      expect(result.card.id).toBeDefined();
    });
  });

  describe("getCard", () => {
    it("returns a card by id", async () => {
      const created = await createCard({
        deckId: testDeckId,
        front: "Q",
        back: "A",
      });

      const card = await getCard(created.card.id);
      expect(card).not.toBeNull();
      expect(card!.front).toBe("Q");
    });

    it("returns null for nonexistent id", async () => {
      const card = await getCard("nonexistent");
      expect(card).toBeNull();
    });
  });

  describe("updateCard", () => {
    it("updates front and back", async () => {
      const { card } = await createCard({
        deckId: testDeckId,
        front: "Q",
        back: "A",
      });

      const updated = await updateCard(card.id, {
        front: "Updated Q",
        back: "Updated A",
      });

      expect(updated.front).toBe("Updated Q");
      expect(updated.back).toBe("Updated A");
    });

    it("updates tags", async () => {
      const { card } = await createCard({
        deckId: testDeckId,
        front: "Q",
        back: "A",
      });

      const updated = await updateCard(card.id, {
        tags: "react,hooks",
      });

      expect(updated.tags).toBe("react,hooks");
    });
  });

  describe("deleteCard", () => {
    it("removes the card from the database", async () => {
      const { card } = await createCard({
        deckId: testDeckId,
        front: "Q",
        back: "A",
      });

      await deleteCard(card.id);

      const found = await getCard(card.id);
      expect(found).toBeNull();
    });
  });

  describe("suspendCard / unsuspendCard", () => {
    it("suspends and unsuspends a card", async () => {
      const { card } = await createCard({
        deckId: testDeckId,
        front: "Q",
        back: "A",
      });

      const suspended = await suspendCard(card.id);
      expect(suspended.suspended).toBe(true);

      const unsuspended = await unsuspendCard(card.id);
      expect(unsuspended.suspended).toBe(false);
    });
  });

  describe("searchCards", () => {
    it("searches by text in front", async () => {
      await createCard({
        deckId: testDeckId,
        front: "What is a closure?",
        back: "A function",
      });
      await createCard({
        deckId: testDeckId,
        front: "What is a variable?",
        back: "A named storage",
      });

      const results = await searchCards("closure");
      expect(results.length).toBe(1);
      expect(results[0].front).toContain("closure");
    });

    it("searches by text in back", async () => {
      await createCard({
        deckId: testDeckId,
        front: "Q",
        back: "React hooks are functions",
      });

      const results = await searchCards("hooks");
      expect(results.length).toBe(1);
    });

    it("filters by deck", async () => {
      const db = getDb();
      const deck2 = await db.deck.create({
        data: { name: "TypeScript" },
      });

      await createCard({
        deckId: testDeckId,
        front: "React closure",
        back: "A",
      });
      await createCard({
        deckId: deck2.id,
        front: "TypeScript closure",
        back: "B",
      });

      const results = await searchCards("closure", { deckId: testDeckId });
      expect(results.length).toBe(1);
      expect(results[0].front).toContain("React");
    });

    it("filters by tags", async () => {
      await createCard({
        deckId: testDeckId,
        front: "Q1",
        back: "A1",
        tags: ["hooks", "react"],
      });
      await createCard({
        deckId: testDeckId,
        front: "Q2",
        back: "A2",
        tags: ["state", "react"],
      });

      const results = await searchCards("", { tags: ["hooks"] });
      expect(results.length).toBe(1);
      expect(results[0].front).toBe("Q1");
    });
  });
});
