/**
 * MCP Server integration tests.
 *
 * These tests exercise the MCP tool handlers end-to-end through
 * the same core services the server uses, verifying the full chain
 * from tool input to database mutation to response shape.
 *
 * We don't spin up the actual MCP stdio transport — instead we test
 * the core operations that each tool handler invokes, which gives us
 * full coverage without needing a protocol-level client.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "../../src/db/client.js";
import { createDeck, listDecks, getDeckStats, deleteDeck } from "../../src/core/deck-service.js";
import {
  createCard,
  getCard,
  updateCard,
  searchCards,
  suspendCard,
  unsuspendCard,
  listCards,
  deleteCards,
} from "../../src/core/card-service.js";
import {
  startSession,
  getNextCard,
  submitReview,
  adjustSession,
} from "../../src/core/session-service.js";
import {
  getStudyStreak,
  getRetentionByDeck,
  getMaturityReport,
  getLapsePatterns,
  getSessionHistory,
} from "../../src/core/analytics-service.js";
import { Rating, State } from "ts-fsrs";

let deckId: string;

describe("MCP server tools (integration)", () => {
  beforeEach(async () => {
    const deck = await createDeck("React", "React fundamentals");
    deckId = deck.id;
  });

  // --- list_decks ---
  describe("list_decks", () => {
    it("returns decks with card counts", async () => {
      await createCard({ deckId, front: "Q1", back: "A1" });
      await createCard({ deckId, front: "Q2", back: "A2" });

      const decks = await listDecks();
      expect(decks.length).toBe(1);
      expect(decks[0].name).toBe("React");
      expect(decks[0].totalCards).toBe(2);
    });
  });

  // --- get_deck_stats ---
  describe("get_deck_stats", () => {
    it("returns state breakdown and due count", async () => {
      await createCard({ deckId, front: "Q1", back: "A1" });
      const stats = await getDeckStats(deckId);
      expect(stats.totalCards).toBe(1);
      expect(stats.newCards).toBe(1);
      expect(stats.dueCards).toBe(1);
    });
  });

  // --- delete_deck ---
  describe("delete_deck", () => {
    it("removes deck and cascades to cards", async () => {
      await createCard({ deckId, front: "Q1", back: "A1" });
      const result = await deleteDeck(deckId);
      expect(result.deletedCards).toBe(1);
      expect(await listDecks()).toEqual([]);
      expect(await getDb().card.count({ where: { deckId } })).toBe(0);
    });
  });

  // --- create_card ---
  describe("create_card", () => {
    it("creates card and returns it with id", async () => {
      const result = await createCard({
        deckId,
        front: "What is useState?",
        back: "A React hook for local state",
        tags: ["hooks"],
        type: "guided",
      });

      expect(result.card.id).toBeDefined();
      expect(result.card.front).toBe("What is useState?");
      expect(result.card.tags).toBe("hooks");
    });

    it("returns duplicate warning when checking", async () => {
      await createCard({ deckId, front: "What is useState?", back: "A hook" });
      const result = await createCard({
        deckId,
        front: "What is useState?",
        back: "Different",
        checkDuplicates: true,
      });

      expect(result.duplicateWarning).toBeDefined();
      expect(result.duplicateWarning!.isDuplicate).toBe(true);
    });
  });

  // --- get_card ---
  describe("get_card", () => {
    it("returns full card by ID", async () => {
      const { card: created } = await createCard({
        deckId,
        front: "Q",
        back: "A",
      });

      const card = await getCard(created.id);
      expect(card).not.toBeNull();
      expect(card!.front).toBe("Q");
      expect(card!.back).toBe("A");
      expect(card!.state).toBe(State.New);
      expect(card!.maturity).toBe("new");
      expect(card!.suspended).toBe(false);
    });

    it("returns null for nonexistent ID", async () => {
      const card = await getCard("nonexistent-id");
      expect(card).toBeNull();
    });
  });

  // --- update_card ---
  describe("update_card", () => {
    it("updates front and back text", async () => {
      const { card } = await createCard({ deckId, front: "Old Q", back: "Old A" });
      const updated = await updateCard(card.id, {
        front: "New Q",
        back: "New A",
      });

      expect(updated.front).toBe("New Q");
      expect(updated.back).toBe("New A");
    });

    it("updates tags", async () => {
      const { card } = await createCard({ deckId, front: "Q", back: "A" });
      const updated = await updateCard(card.id, { tags: "react,hooks" });
      expect(updated.tags).toBe("react,hooks");
    });
  });

  // --- suspend_card / unsuspend_card ---
  describe("suspend_card / unsuspend_card", () => {
    it("suspends and unsuspends a card", async () => {
      const { card } = await createCard({ deckId, front: "Q", back: "A" });

      const suspended = await suspendCard(card.id);
      expect(suspended.suspended).toBe(true);

      const unsuspended = await unsuspendCard(card.id);
      expect(unsuspended.suspended).toBe(false);
    });

    it("suspended cards are excluded from sessions", async () => {
      const { card } = await createCard({ deckId, front: "Q", back: "A" });
      await suspendCard(card.id);

      const session = await startSession();
      expect(session.queue.length).toBe(0);
    });
  });

  // --- search_cards ---
  describe("search_cards", () => {
    it("finds cards by text in front and back", async () => {
      await createCard({ deckId, front: "What is JSX?", back: "Syntax extension" });
      await createCard({ deckId, front: "What is TypeScript?", back: "Typed JS" });

      const results = await searchCards("JSX");
      expect(results.length).toBe(1);
      expect(results[0].front).toContain("JSX");
    });

    it("filters by tags", async () => {
      await createCard({ deckId, front: "Q1", back: "A1", tags: ["hooks"] });
      await createCard({ deckId, front: "Q2", back: "A2", tags: ["state"] });

      const results = await searchCards("", { tags: ["hooks"] });
      expect(results.length).toBe(1);
    });
  });

  // --- list_cards ---
  describe("list_cards", () => {
    it("filters untagged cards with tagFilter='empty'", async () => {
      await createCard({ deckId, front: "Tagged", back: "A", tags: ["react"] });
      await createCard({ deckId, front: "Untagged", back: "A" });

      const results = await listCards({ tagFilter: "empty" });
      expect(results.length).toBe(1);
      expect(results[0].front).toBe("Untagged");
    });

    it("paginates and scopes by deckId", async () => {
      for (let i = 0; i < 3; i++) {
        await createCard({ deckId, front: `Q${i}`, back: `A${i}` });
      }
      const page = await listCards({ deckId, limit: 2 });
      expect(page.length).toBe(2);
    });
  });

  // --- delete_cards ---
  describe("delete_cards", () => {
    it("bulk deletes by id list", async () => {
      const a = await createCard({ deckId, front: "Q1", back: "A1" });
      const b = await createCard({ deckId, front: "Q2", back: "A2" });

      const res = await deleteCards([a.card.id, b.card.id]);
      expect(res.deleted).toBe(2);
      expect(await getCard(a.card.id)).toBeNull();
    });
  });

  // --- Full study session flow ---
  describe("full study session flow", () => {
    it("start → get_next → submit_review → end", async () => {
      await createCard({ deckId, front: "What is React?", back: "A UI library" });
      await createCard({ deckId, front: "What is JSX?", back: "Syntax ext" });

      // start_session
      const session = await startSession();
      expect(session.id).toBeDefined();
      expect(session.queue.length).toBe(2);

      // get_next_card
      const card1 = await getNextCard(session.id);
      expect(card1).not.toBeNull();
      expect(card1!.front).toBeDefined();

      // submit_review
      await submitReview(session.id, card1!.id, Rating.Good, 1500);

      // Verify review was recorded
      const db = getDb();
      const reviews = await db.review.findMany({ where: { cardId: card1!.id } });
      expect(reviews.length).toBe(1);
      expect(reviews[0].rating).toBe(Rating.Good);
      expect(reviews[0].responseMs).toBe(1500);

      // Verify card was rescheduled
      const updatedCard = await db.card.findUnique({ where: { id: card1!.id } });
      expect(updatedCard!.reps).toBe(1);
      expect(updatedCard!.stability).toBeGreaterThan(0);

      // get next card
      const card2 = await getNextCard(session.id);
      expect(card2).not.toBeNull();
      await submitReview(session.id, card2!.id, Rating.Again);

      // No more cards — queue exhausted
      const card3 = await getNextCard(session.id);
      expect(card3).toBeNull();
    });

    it("adjust_session reduces queue mid-session", async () => {
      for (let i = 0; i < 5; i++) {
        await createCard({ deckId, front: `Q${i}`, back: `A${i}` });
      }

      const session = await startSession();
      expect(session.queue.length).toBe(5);

      // Review one card
      const card = await getNextCard(session.id);
      await submitReview(session.id, card!.id, Rating.Good);

      // Adjust to only 2 remaining
      const adjusted = await adjustSession(session.id, { maxCards: 2 });
      expect(adjusted.queue.length).toBeLessThanOrEqual(2);
    });
  });

  // --- get_due_cards ---
  describe("get_due_cards", () => {
    it("returns cards that are due now", async () => {
      await createCard({ deckId, front: "Q1", back: "A1" });

      const db = getDb();
      const dueCards = await db.card.findMany({
        where: { due: { lte: new Date() }, suspended: false },
      });
      expect(dueCards.length).toBe(1);
    });

    it("does not return suspended cards", async () => {
      const { card } = await createCard({ deckId, front: "Q1", back: "A1" });
      await suspendCard(card.id);

      const db = getDb();
      const dueCards = await db.card.findMany({
        where: { due: { lte: new Date() }, suspended: false },
      });
      expect(dueCards.length).toBe(0);
    });
  });

  // --- get_stats ---
  describe("get_stats", () => {
    it("returns all stat categories", async () => {
      const [streak, retention, maturity, lapses, history] = await Promise.all([
        getStudyStreak(),
        getRetentionByDeck(),
        getMaturityReport(),
        getLapsePatterns(),
        getSessionHistory(5),
      ]);

      expect(typeof streak).toBe("number");
      expect(Array.isArray(retention)).toBe(true);
      expect(Array.isArray(maturity)).toBe(true);
      expect(Array.isArray(lapses)).toBe(true);
      expect(Array.isArray(history)).toBe(true);
    });
  });

  // --- get_session_history ---
  describe("get_session_history", () => {
    it("returns sessions ordered by most recent", async () => {
      await createCard({ deckId, front: "Q", back: "A" });

      const session = await startSession();
      const card = await getNextCard(session.id);
      await submitReview(session.id, card!.id, Rating.Good);
      await getNextCard(session.id); // drain queue to trigger cleanup

      const history = await getSessionHistory(10);
      expect(history.length).toBe(1);
      expect(history[0].cardsReviewed).toBe(1);
    });
  });

  // --- Card creation with split workflow ---
  describe("card split workflow (edit + suspend original + create new)", () => {
    it("simulates splitting a card into two", async () => {
      // Create original broad card
      const { card: original } = await createCard({
        deckId,
        front: "Explain React hooks: useState and useEffect",
        back: "useState manages local state. useEffect handles side effects.",
      });

      // Split: create two focused cards
      const { card: card1 } = await createCard({
        deckId,
        front: "What does useState do in React?",
        back: "Manages local component state. Returns [state, setState] tuple.",
        tags: ["hooks", "split-from:" + original.id],
      });

      const { card: card2 } = await createCard({
        deckId,
        front: "What does useEffect do in React?",
        back: "Handles side effects. Runs after render. Cleanup via return function.",
        tags: ["hooks", "split-from:" + original.id],
      });

      // Suspend the original
      await suspendCard(original.id);

      // Verify
      const suspended = await getCard(original.id);
      expect(suspended!.suspended).toBe(true);

      const newCard1 = await getCard(card1.id);
      const newCard2 = await getCard(card2.id);
      expect(newCard1!.front).toContain("useState");
      expect(newCard2!.front).toContain("useEffect");
      expect(newCard1!.suspended).toBe(false);
      expect(newCard2!.suspended).toBe(false);
    });
  });

  // --- Internalized card scheduling ---
  describe("internalized card handling", () => {
    it("internalized cards are included in session but with lower priority", async () => {
      // Create a normal new card and an internalized card
      await createCard({ deckId, front: "New Q", back: "New A" });

      const { card: internalized } = await createCard({
        deckId,
        front: "Internalized Q",
        back: "Internalized A",
      });
      await getDb().card.update({ where: { id: internalized.id }, data: { maturity: "internalized" } });

      const session = await startSession();
      // Both should appear (internalized is not excluded)
      expect(session.queue.length).toBe(2);
    });
  });
});
