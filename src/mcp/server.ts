#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, setDb, getDb } from "../db/client.js";
import { listDecks, getDeckStats, deleteDeck } from "../core/deck-service.js";
import {
  createCard,
  getCard,
  updateCard,
  deleteCard,
  deleteCards,
  searchCards,
  listCards,
  suspendCard,
  unsuspendCard,
  getDueCards,
  findSimilar,
} from "../core/card-service.js";
import { parseTags } from "../core/types.js";
import {
  startSession,
  getNextCard,
  submitReview,
  skipCard,
  adjustSession,
} from "../core/session-service.js";
import {
  getFullStats,
  getSessionHistory,
} from "../core/analytics-service.js";
import type { Grade } from "ts-fsrs";

const prisma = createClient();
setDb(prisma);

const server = new McpServer(
  { name: "flashcard-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

/** Build a standard text result containing JSON-serialized data. */
function j(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// --- Tools ---
// McpServer validates each call's arguments against the Zod inputSchema and
// catches handler throws, returning an isError result automatically — no manual
// ListTools handler or per-tool try/catch needed.

server.registerTool(
  "start_session",
  {
    description: "Start a study session. Returns session ID and card queue info.",
    inputSchema: {
      maxNewCards: z.number().optional().describe("Max new cards (default 5)"),
      maxReviewCards: z.number().optional().describe("Max review cards (default 15)"),
      practiceFirst: z.boolean().optional().describe("Prioritize unguided/exercise cards"),
      category: z
        .string()
        .optional()
        .describe("Only include cards with this category. Omit for all cards."),
    },
  },
  async (args) => {
    const result = await startSession({
      maxNewCardsPerSession: args.maxNewCards,
      maxReviewCardsPerSession: args.maxReviewCards,
      practiceFirstMode: args.practiceFirst,
      category: args.category,
    });
    return j({
      sessionId: result.id,
      queueLength: result.queue.length,
      queue: result.queue,
    });
  }
);

server.registerTool(
  "get_next_card",
  {
    description: "Get the next card in the current study session.",
    inputSchema: { sessionId: z.string() },
  },
  async (args) => {
    const card = await getNextCard(args.sessionId);
    return j(
      card
        ? {
            id: card.id,
            front: card.front,
            back: card.back,
            type: card.type,
            maturity: card.maturity,
            tags: card.tags,
            category: card.category,
            reps: card.reps,
            lapses: card.lapses,
          }
        : { done: true, message: "No more cards in queue" }
    );
  }
);

server.registerTool(
  "submit_review",
  {
    description:
      "Submit a rating for a card. Rating: 1=Again, 2=Hard, 3=Good, 4=Easy. Returns the new schedule: due (ISO timestamp), interval (days, 0 for intra-day learning steps), state, and intraDay (true when the card resurfaces in under a day).",
    inputSchema: {
      sessionId: z.string(),
      cardId: z.string(),
      rating: z
        .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
        .describe("1=Again, 2=Hard, 3=Good, 4=Easy"),
      responseMs: z.number().optional().describe("Response time in milliseconds"),
    },
  },
  async (args) => {
    const schedule = await submitReview(
      args.sessionId,
      args.cardId,
      args.rating as Grade,
      args.responseMs
    );
    return j({ success: true, ...schedule });
  }
);

server.registerTool(
  "skip_card",
  {
    description:
      "Skip the current card without reviewing it. Advances to the next card in the queue.",
    inputSchema: { sessionId: z.string() },
  },
  async (args) => {
    const skipped = skipCard(args.sessionId);
    return j({ skipped });
  }
);

server.registerTool(
  "adjust_session",
  {
    description: "Adjust current session: change card count or focus deck.",
    inputSchema: {
      sessionId: z.string(),
      maxCards: z.number().optional(),
      focusDeck: z.string().optional(),
      focusCategory: z.string().optional().describe("Narrow queue to this category"),
    },
  },
  async (args) => {
    const adjusted = await adjustSession(args.sessionId, {
      maxCards: args.maxCards,
      focusDeck: args.focusDeck,
      focusCategory: args.focusCategory,
    });
    return j({ remainingCards: adjusted.queue.length, queue: adjusted.queue });
  }
);

server.registerTool(
  "get_stats",
  { description: "Get study statistics: streak, retention, maturity, lapse patterns." },
  async () => j(await getFullStats())
);

server.registerTool(
  "list_decks",
  { description: "List all decks with card counts and stats." },
  async () => {
    const decks = await listDecks();
    const decksWithStats = await Promise.all(
      decks.map(async (d) => ({ ...d, stats: await getDeckStats(d.id) }))
    );
    return j(decksWithStats);
  }
);

server.registerTool(
  "get_deck_stats",
  {
    description: "Get detailed stats for a specific deck.",
    inputSchema: { deckId: z.string() },
  },
  async (args) => j(await getDeckStats(args.deckId))
);

server.registerTool(
  "delete_deck",
  {
    description:
      "Permanently delete a deck and all its cards and review history. Irreversible.",
    inputSchema: { deckId: z.string() },
  },
  async (args) => {
    const result = await deleteDeck(args.deckId);
    return j({ deleted: true, deletedCards: result.deletedCards });
  }
);

server.registerTool(
  "create_card",
  {
    description:
      "Create a new flashcard. Returns card and duplicate warnings. When splitting or deriving a card from an existing one, pass inheritFrom with the source card's id so the new card keeps the parent's FSRS schedule (due, stability, interval, state) instead of resetting to a fresh New card.",
    inputSchema: {
      deckId: z.string(),
      front: z.string(),
      back: z.string(),
      tags: z.array(z.string()).optional(),
      type: z.enum(["guided", "unguided"]).optional(),
      category: z.string().optional().describe("Card category"),
      inheritFrom: z
        .string()
        .optional()
        .describe(
          "Source card id to inherit the FSRS scheduling block from (due, stability, difficulty, reps, lapses, state, lastReview, interval, maturity). Use when splitting a card so the new cards honour the original's stability."
        ),
    },
  },
  async (args) => {
    const result = await createCard({
      deckId: args.deckId,
      front: args.front,
      back: args.back,
      tags: args.tags,
      type: args.type,
      category: args.category,
      inheritFrom: args.inheritFrom,
      checkDuplicates: true,
    });
    return j({
      card: {
        id: result.card.id,
        front: result.card.front,
        back: result.card.back,
        due: result.card.due,
        interval: result.card.interval,
        stability: result.card.stability,
        state: result.card.state,
      },
      duplicateWarning: result.duplicateWarning,
    });
  }
);

server.registerTool(
  "get_card",
  {
    description: "Get a single card by ID with all fields.",
    inputSchema: { cardId: z.string() },
  },
  async (args) => {
    const card = await getCard(args.cardId);
    if (!card) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Card not found" }) }], isError: true };
    }
    return j({
      id: card.id,
      deckId: card.deckId,
      front: card.front,
      back: card.back,
      tags: card.tags,
      category: card.category,
      type: card.type,
      maturity: card.maturity,
      state: card.state,
      reps: card.reps,
      lapses: card.lapses,
      stability: card.stability,
      due: card.due,
      suspended: card.suspended,
    });
  }
);

server.registerTool(
  "update_card",
  {
    description: "Update a card's front, back, or tags.",
    inputSchema: {
      cardId: z.string(),
      front: z.string().optional(),
      back: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated tags"),
      category: z
        .string()
        .nullable()
        .optional()
        .describe("Set card category; pass null to clear"),
    },
  },
  async (args) => {
    const updates: {
      front?: string;
      back?: string;
      tags?: string;
      category?: string | null;
    } = {};
    if (args.front != null) updates.front = args.front;
    if (args.back != null) updates.back = args.back;
    if (args.tags !== undefined) updates.tags = args.tags;
    if (args.category !== undefined) updates.category = args.category;
    const updated = await updateCard(args.cardId, updates);
    return j({
      id: updated.id,
      front: updated.front,
      back: updated.back,
      tags: updated.tags,
    });
  }
);

server.registerTool(
  "delete_card",
  {
    description: "Permanently delete a card and all its review history.",
    inputSchema: { cardId: z.string() },
  },
  async (args) => {
    await deleteCard(args.cardId);
    return j({ deleted: true });
  }
);

server.registerTool(
  "unsuspend_card",
  {
    description: "Unsuspend a previously suspended card.",
    inputSchema: { cardId: z.string() },
  },
  async (args) => {
    const card = await unsuspendCard(args.cardId);
    return j({ suspended: card.suspended });
  }
);

server.registerTool(
  "suspend_card",
  {
    description: "Fully suspend a card (won't appear in sessions).",
    inputSchema: { cardId: z.string() },
  },
  async (args) => {
    const card = await suspendCard(args.cardId);
    return j({ suspended: card.suspended });
  }
);

server.registerTool(
  "list_cards",
  {
    description:
      "List cards with optional deck/tag/state filters and pagination. tagFilter accepts 'empty' (untagged), 'has_any' (any tag), or an exact tag string. state filters by FSRS state. Returns id, truncated front/back, tags array, maturity, lapses, deckId. Default limit 50 (max 200).",
    inputSchema: {
      deckId: z.string().optional(),
      tagFilter: z.string().optional().describe("'empty' | 'has_any' | exact tag string"),
      category: z
        .string()
        .optional()
        .describe(
          "Exact category name, or '__uncategorized__' for null, or '__any__' for any category."
        ),
      state: z
        .enum(["new", "learning", "review", "relearning"])
        .optional()
        .describe("Filter by FSRS state."),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
  },
  async (args) => {
    const cards = await listCards({
      deckId: args.deckId,
      tagFilter: args.tagFilter,
      category: args.category,
      state: args.state,
      limit: args.limit,
      offset: args.offset,
    });
    const trunc = (s: string): string => (s.length > 120 ? s.slice(0, 120) + "…" : s);
    return j({
      count: cards.length,
      cards: cards.map((c) => ({
        id: c.id,
        deckId: c.deckId,
        front: trunc(c.front),
        back: trunc(c.back),
        tags: parseTags(c.tags),
        category: c.category,
        maturity: c.maturity,
        lapses: c.lapses,
      })),
    });
  }
);

server.registerTool(
  "delete_cards",
  {
    description:
      "Permanently delete multiple cards by ID. Returns count of cards deleted. Irreversible.",
    inputSchema: { cardIds: z.array(z.string()) },
  },
  async (args) => j(await deleteCards(args.cardIds))
);

server.registerTool(
  "search_cards",
  {
    description: "Search cards by text query and optional filters.",
    inputSchema: {
      query: z.string(),
      deckId: z.string().optional(),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
    },
  },
  async (args) => {
    const results = await searchCards(args.query, {
      deckId: args.deckId,
      tags: args.tags,
      category: args.category,
    });
    return j(
      results.map((c) => ({
        id: c.id,
        front: c.front,
        back: c.back,
        tags: c.tags,
        maturity: c.maturity,
        state: c.state,
      }))
    );
  }
);

server.registerTool(
  "get_due_cards",
  {
    description:
      "Returns the total number of cards due now plus a preview of up to 30 (ordered by due date ascending). `totalDue` is the real backlog size; `preview` may be shorter. If you need every due card, use list_cards with additional filters.",
  },
  async () => {
    const db = getDb();
    const previewLimit = 30;
    const [totalDue, dueCards] = await Promise.all([
      db.card.count({ where: { due: { lte: new Date() }, suspended: false } }),
      getDueCards(previewLimit),
    ]);
    return j({
      totalDue,
      previewCount: dueCards.length,
      hasMore: totalDue > dueCards.length,
      preview: dueCards.map((c) => ({
        id: c.id,
        front: c.front.slice(0, 80),
        deck: c.deck.name,
        state: c.state,
        maturity: c.maturity,
      })),
    });
  }
);

server.registerTool(
  "get_session_history",
  {
    description: "Get recent study session history.",
    inputSchema: {
      limit: z.number().optional().describe("Number of sessions (default 10)"),
    },
  },
  async (args) => j(await getSessionHistory(args.limit ?? 10))
);

server.registerTool(
  "find_similar_cards",
  {
    description:
      "Find cards semantically similar to a given text. Uses both word-overlap and embedding similarity. Useful for checking if a card already exists before creating it.",
    inputSchema: {
      text: z.string().describe("The card front text to check against existing cards"),
      deckId: z.string().optional().describe("Limit search to this deck (optional)"),
      threshold: z.number().optional().describe("Cosine similarity threshold 0-1 (default 0.45)"),
    },
  },
  async (args) => {
    const similar = await findSimilar(args.text, {
      deckId: args.deckId,
      cosineThreshold: args.threshold,
    });
    return j({
      count: similar.length,
      cards: similar.slice(0, 10).map((c) => ({
        id: c.id,
        front: c.front,
        similarity: `${(c.similarity * 100).toFixed(0)}%`,
      })),
    });
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
