#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, setDb, getDb } from "../db/client.js";
import { normalizeDates } from "../db/normalize.js";
import { listDecks, getDeckStats, deleteDeck } from "../core/deck-service.js";
import { cardMaturity } from "../core/scheduler.js";
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
  getQueuePosition,
  submitReview,
  skipCard,
  adjustSession,
  endSession,
} from "../core/session-service.js";
import {
  getFullStats,
  getSessionHistory,
} from "../core/analytics-service.js";
import { checkPressure } from "../core/pressure.js";
import { checkCalibration } from "../core/calibration.js";
import { deferLeech, leechPayload } from "../core/leeches.js";
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
    description:
      "Start a study session. Returns sessionId, queueLength and queue (items of {cardId, reason}). The queue holds due review cards, lowest recall probability first, up to maxReviewCards, followed by up to maxNewCards New cards (at most 3 when more than 10 reviews are queued); with practiceFirst, unguided New cards move to the front. It does not consult check_pressure. Starting a session deletes every open session that has no reviews yet, so their session ids stop working.",
    inputSchema: {
      maxNewCards: z.number().optional().describe("Max new cards (default 5)"),
      maxReviewCards: z.number().optional().describe("Max review cards (default 15)"),
      practiceFirst: z.boolean().optional().describe("Prioritize unguided/exercise cards (default true)"),
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
    description:
      "Get the next card in the current study session. Includes `position` (1-based) and `total` (current session size) for a `Card position/total` line; `total` grows by one whenever submit_review returns intraDay: true, since that card is re-queued at the end. `repeat: true` marks a re-served intra-day learning repeat. A served card that has lapsed 5+ times comes back with a `leech` field ({lapses, mustResolve: true}) and stops the loop: the next call to this tool errors until that card is rewritten (update_card), split (create_card with inheritFrom, then delete_card), deleted, or kept as-is via resolve_leech.",
    inputSchema: { sessionId: z.string() },
  },
  async (args) => {
    const card = await getNextCard(args.sessionId);
    if (card == null) return j({ done: true, message: "No more cards in queue" });
    const leech = leechPayload(card);
    const queuePosition = await getQueuePosition(args.sessionId);
    return j({
      ...(queuePosition ?? {}),
      id: card.id,
      front: card.front,
      back: card.back,
      type: card.type,
      maturity: cardMaturity(card),
      tags: card.tags,
      category: card.category,
      reps: card.reps,
      lapses: card.lapses,
      ...(leech ? { leech } : {}),
    });
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
      "Skip the current card without reviewing it. Advances to the next card in the queue; no review is recorded, the card's schedule is unchanged, and it does not come back this session. Returns skipped: false for an unknown or ended session.",
    inputSchema: { sessionId: z.string() },
  },
  async (args) => {
    const skipped = await skipCard(args.sessionId);
    return j({ skipped });
  }
);

server.registerTool(
  "end_session",
  {
    description:
      "Close a study session. Call this when the session is over (after the summary) so the row stops counting as open. Reviews do not close a session on their own. Idempotent; returns null if the session id is unknown.",
    inputSchema: {
      sessionId: z.string(),
    },
  },
  async (args) => {
    const ended = await endSession(args.sessionId);
    if (ended == null) return j(null);
    return j({
      id: ended.id,
      startTime: ended.startTime.toISOString(),
      endTime: ended.endTime?.toISOString() ?? null,
      cardsReviewed: ended.cardsReviewed,
      newCards: ended.newCards,
      accuracy: ended.accuracy,
    });
  }
);

server.registerTool(
  "adjust_session",
  {
    description:
      "Narrow the rest of a session's queue, from the current card on. maxCards keeps only the next N cards; focusDeck and focusCategory drop the cards outside that deck or category (applied after maxCards). It never adds cards and leaves reviewed or skipped cards alone. Returns remainingCards and the remaining queue; an unknown or ended session returns an empty queue instead of an error.",
    inputSchema: {
      sessionId: z.string(),
      maxCards: z.number().optional().describe("Keep at most this many cards, counting from the current one"),
      focusDeck: z
        .string()
        .optional()
        .describe("Deck id from list_decks, not the deck name: a name matches no card and empties the rest of the session"),
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
  {
    description:
      "Get study statistics: streak (consecutive local days with reviews, ending today), per-deck retention, per-deck maturity counts, the 20 cards with the most lapses, and the 5 most recent sessions. Retention here is each deck's average predicted recall probability (FSRS retrievability) right now, not measured accuracy; check_calibration reports the measured true retention and the difficulty verdict.",
  },
  async () => j(await getFullStats())
);

server.registerTool(
  "check_pressure",
  {
    description:
      "SRS pressure check: the single source of truth for due counts and the pressure verdict. Two axes: review backlog (due cards excluding state New) and cards added today. Returns verdict (ok|warn|pause), flashcardsDue, newAvailable (due new cards, visibility only, never pressure), newToday, reasons, thresholds, clearance, and per-deck stats. clearance covers the flashcards axis only, giving the reviews needed to drop below warn/pause; the cards-added-today axis has none, because reviewing cannot lower it and intake resets at the start of the next day. The verdict token is authoritative: pause blocks create_card (inheritFrom splits exempt). Do not derive counts from get_due_cards, which caps its preview at 30.",
  },
  async () => j(await checkPressure())
);

server.registerTool(
  "check_calibration",
  {
    description:
      "Study calibration check: is the session asking questions at the right difficulty? Returns true_retention over the last 30 days (Anki's true-retention convention: reviews with elapsedDays >= 1, first review per card per local day, rated >= 3), the rating mix, and a verdict — over-difficult (below 80%), calibrated (80-90%), under-difficult (above 90%), or low-signal. low-signal means the number is not trustworthy yet: fewer than 50 eligible reviews, or more than 80% of ratings are Good, which is a grading-discrimination problem rather than a difficulty one. `marginal` flags a retention within 2 points of a band edge — soften the difficulty levers, do not switch them off. This verdict drives question difficulty only; it must never loosen the rating rubric, since the ratings are what produce the number.",
  },
  async () => j(await checkCalibration())
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
    description:
      "Get one deck's card counts: totalCards, cards per FSRS state (newCards, learningCards, reviewCards, relearningCards), and unsuspended cards due now, in total (dueCards, New cards included) and per state (dueNew, dueLearning, dueReview, dueRelearning). list_decks and check_pressure return this same object for every deck. Errors if the deck id is unknown.",
    inputSchema: { deckId: z.string() },
  },
  async (args) => j(await getDeckStats(args.deckId))
);

server.registerTool(
  "delete_deck",
  {
    description:
      "Permanently delete a deck and all its cards and review history. Irreversible. Each card leaves a tombstone so the deletion propagates through Anki sync.",
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
      "Create a new flashcard. Returns the card and, when it resembles existing cards in the same deck, a duplicateWarning; the card is created even when duplicateWarning.isDuplicate is true. When splitting or deriving a card from an existing one, pass inheritFrom with the source card's id so the new card keeps the parent's FSRS schedule (due, stability, interval, state) instead of resetting to a fresh New card. Creation is blocked with an error while check_pressure reads pause (50+ reviews due, or 10+ cards added today); splits via inheritFrom are exempt. Front and back are simple HTML, the only format Anki renders reliably; content that breaks the rules on those two parameters is rejected with an error listing each violation.",
    inputSchema: {
      deckId: z.string().describe("Deck id from list_decks, not the deck name"),
      front: z
        .string()
        .describe(
          "Question side, as simple HTML: <b>, <i>, <code>, <pre>, <ul>/<ol>/<li>, <br>. Must ask one question. Rejected: Markdown (backticks, **bold**, list lines), [[wikilinks]], em dashes, and newlines outside <pre>."
        ),
      back: z
        .string()
        .describe(
          "Answer side, as simple HTML with the same format rules as front. Rejected above 200 visible characters or 4 sentences; markup does not count toward either limit."
        ),
      tags: z.array(z.string()).optional(),
      type: z
        .enum(["guided", "unguided"])
        .optional()
        .describe("unguided marks an exercise card, which practiceFirst sessions serve first (default guided)"),
      category: z.string().optional().describe("Card category"),
      inheritFrom: z
        .string()
        .optional()
        .describe(
          "Source card id to inherit the FSRS scheduling block from (due, stability, difficulty, reps, lapses, state, lastReview, interval). Use when splitting a card so the new cards honour the original's stability."
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
    description:
      "Get a single card by ID: id, deckId, front, back, tags (comma-separated string), category, type, maturity, state (FSRS state number: 0 new, 1 learning, 2 review, 3 relearning), reps, lapses, stability, due and suspended. Other columns (difficulty, interval, lastReview, leech flags) are not returned. Returns an error result with \"Card not found\" for an unknown ID.",
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
      maturity: cardMaturity(card),
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
    description:
      "Update a card's front, back, tags, or category; fields you omit stay unchanged. Returns id, front, back and tags. A new front or back must follow the same content rules as in create_card, or the update is rejected with an error listing each violation. Updating a card that get_next_card flagged as a leech also clears the flag and resets its lapse count to 0: those lapses were earned by the old wording, and the rewrite is the resolution. Cards with no flag keep their lapse count.",
    inputSchema: {
      cardId: z.string(),
      front: z.string().optional().describe("New question side, as simple HTML (same rules as create_card's front)"),
      back: z.string().optional().describe("New answer side, as simple HTML (same rules and limits as create_card's back)"),
      tags: z.string().optional().describe("Comma-separated tags; replaces all existing tags"),
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
  "resolve_leech",
  {
    description:
      "Answer a leech flag raised by get_next_card. action \"defer\" keeps the card exactly as it is and lets the session continue; the card flags again the next time it lapses. The other ways out need no tool of their own: update_card rewrites it, create_card with inheritFrom plus delete_card splits it, delete_card drops it.",
    inputSchema: {
      cardId: z.string(),
      action: z.enum(["defer"]).describe("defer: keep the card as-is until it fails again"),
    },
  },
  async (args) => {
    const card = await deferLeech(args.cardId);
    return j({ cardId: card.id, deferredAtLapses: card.leechDeferredLapses });
  }
);

server.registerTool(
  "delete_card",
  {
    description:
      "Permanently delete a card and all its review history. Leaves a tombstone so the deletion propagates through Anki sync instead of the card being re-imported.",
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
    description:
      "Suspend a card: new sessions leave it out and due counts skip it, but a session that already queued it still serves it. A suspended card still counts toward cards added today. Returns suspended: true.",
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
      deckId: z.string().optional().describe("Deck id from list_decks, not the deck name, which matches nothing"),
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
        maturity: cardMaturity(c),
        lapses: c.lapses,
      })),
    });
  }
);

server.registerTool(
  "delete_cards",
  {
    description:
      "Permanently delete multiple cards by ID. Returns count of cards deleted. Irreversible. Each deleted card leaves a tombstone so the deletion propagates through Anki sync.",
    inputSchema: { cardIds: z.array(z.string()) },
  },
  async (args) => j(await deleteCards(args.cardIds))
);

server.registerTool(
  "search_cards",
  {
    description:
      "Find cards whose front or back contains the query text: a substring match, not a similarity score (find_similar_cards scores similarity). Returns at most 100 cards, newest first, with full front and back, tags as a comma-separated string, maturity and state.",
    inputSchema: {
      query: z.string().describe("Text to find in front or back; an empty string matches every card that passes the filters"),
      deckId: z.string().optional().describe("Deck id from list_decks, not the deck name"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Each listed tag must appear in the card's tags as a substring, so a short tag also matches longer tags that contain it"),
      category: z
        .string()
        .optional()
        .describe("Exact category name, or '__uncategorized__' for null, or '__any__' for any category."),
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
        maturity: cardMaturity(c),
        state: c.state,
      }))
    );
  }
);

server.registerTool(
  "get_due_cards",
  {
    description:
      "Returns the number of unsuspended cards due now plus a preview of up to 30 of them (ordered by due date ascending). `totalDue` counts New cards too, so it is not the review backlog: check_pressure's flashcardsDue is. `preview` may be shorter than `totalDue` (then `hasMore` is true); each entry carries the front cut to 80 characters, the deck name, state and maturity. No tool lists every due card: list_cards has no due-date filter.",
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
        maturity: cardMaturity(c),
      })),
    });
  }
);

server.registerTool(
  "get_session_history",
  {
    description:
      "Get the most recent study sessions, newest first, as stored: id, startTime, endTime, cardsReviewed, newCards, accuracy and queueState. endTime stays null until end_session closes the session, so an abandoned session keeps a null endTime. queueState is the queue of a session that can still be resumed, as JSON, and null once its queue is used up or it has ended.",
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
      "Find cards similar to a given text: word overlap with each card's front (50% and up), plus embedding similarity to each card's front and back once the embedding model has loaded in this server process. The model starts loading in the background on the first create_card, or update_card that changes a front or back; until it has loaded, results come from word overlap alone. Useful for checking if a card already exists before creating it. Returns count (all matches) and the 10 most similar cards.",
    inputSchema: {
      text: z.string().describe("The card front text to check against existing cards"),
      deckId: z.string().optional().describe("Limit search to this deck (optional); a deck id from list_decks, not the deck name, which matches nothing"),
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
  await normalizeDates(prisma);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
