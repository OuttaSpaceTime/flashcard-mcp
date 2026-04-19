#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient, setDb } from "../db/client.js";
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

const server = new Server(
  { name: "flashcard-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// --- Tool definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "start_session",
      description:
        "Start a study session. Returns session ID and card queue info.",
      inputSchema: {
        type: "object" as const,
        properties: {
          maxNewCards: { type: "number", description: "Max new cards (default 5)" },
          maxReviewCards: { type: "number", description: "Max review cards (default 15)" },
          practiceFirst: { type: "boolean", description: "Prioritize unguided/exercise cards" },
        },
      },
    },
    {
      name: "get_next_card",
      description: "Get the next card in the current study session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "submit_review",
      description:
        "Submit a rating for a card. Rating: 1=Again, 2=Hard, 3=Good, 4=Easy.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string" },
          cardId: { type: "string" },
          rating: { type: "number", enum: [1, 2, 3, 4] },
          responseMs: { type: "number", description: "Response time in milliseconds" },
        },
        required: ["sessionId", "cardId", "rating"],
      },
    },
    {
      name: "skip_card",
      description:
        "Skip the current card without reviewing it. Advances to the next card in the queue.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "adjust_session",
      description: "Adjust current session: change card count or focus deck.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string" },
          maxCards: { type: "number" },
          focusDeck: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "get_stats",
      description: "Get study statistics: streak, retention, maturity, lapse patterns.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "list_decks",
      description: "List all decks with card counts and stats.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "get_deck_stats",
      description: "Get detailed stats for a specific deck.",
      inputSchema: {
        type: "object" as const,
        properties: {
          deckId: { type: "string" },
        },
        required: ["deckId"],
      },
    },
    {
      name: "delete_deck",
      description:
        "Permanently delete a deck and all its cards and review history. Irreversible.",
      inputSchema: {
        type: "object" as const,
        properties: {
          deckId: { type: "string" },
        },
        required: ["deckId"],
      },
    },
    {
      name: "create_card",
      description: "Create a new flashcard. Returns card and duplicate warnings.",
      inputSchema: {
        type: "object" as const,
        properties: {
          deckId: { type: "string" },
          front: { type: "string" },
          back: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          type: { type: "string", enum: ["guided", "unguided"] },
        },
        required: ["deckId", "front", "back"],
      },
    },
    {
      name: "get_card",
      description: "Get a single card by ID with all fields.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cardId: { type: "string" },
        },
        required: ["cardId"],
      },
    },
    {
      name: "update_card",
      description: "Update a card's front, back, or tags.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cardId: { type: "string" },
          front: { type: "string" },
          back: { type: "string" },
          tags: { type: "string", description: "Comma-separated tags" },
        },
        required: ["cardId"],
      },
    },
    {
      name: "delete_card",
      description: "Permanently delete a card and all its review history.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cardId: { type: "string" },
        },
        required: ["cardId"],
      },
    },
    {
      name: "unsuspend_card",
      description: "Unsuspend a previously suspended card.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cardId: { type: "string" },
        },
        required: ["cardId"],
      },
    },
    {
      name: "suspend_card",
      description: "Fully suspend a card (won't appear in sessions).",
      inputSchema: {
        type: "object" as const,
        properties: {
          cardId: { type: "string" },
        },
        required: ["cardId"],
      },
    },
    {
      name: "list_cards",
      description:
        "List cards with optional deck/tag filters and pagination. tagFilter accepts 'empty' (untagged), 'has_any' (any tag), or an exact tag string. Returns id, truncated front/back, tags array, maturity, lapses, deckId. Default limit 50 (max 200).",
      inputSchema: {
        type: "object" as const,
        properties: {
          deckId: { type: "string" },
          tagFilter: {
            type: "string",
            description: "'empty' | 'has_any' | exact tag string",
          },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
    },
    {
      name: "delete_cards",
      description:
        "Permanently delete multiple cards by ID. Returns count of cards deleted. Irreversible.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cardIds: { type: "array", items: { type: "string" } },
        },
        required: ["cardIds"],
      },
    },
    {
      name: "search_cards",
      description: "Search cards by text query and optional filters.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string" },
          deckId: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["query"],
      },
    },
    {
      name: "get_due_cards",
      description: "Get count and preview of cards due for review.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "get_session_history",
      description: "Get recent study session history.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Number of sessions (default 10)" },
        },
      },
    },
    {
      name: "find_similar_cards",
      description:
        "Find cards semantically similar to a given text. Uses both word-overlap and embedding similarity. Useful for checking if a card already exists before creating it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "The card front text to check against existing cards" },
          deckId: { type: "string", description: "Limit search to this deck (optional)" },
          threshold: { type: "number", description: "Cosine similarity threshold 0-1 (default 0.45)" },
        },
        required: ["text"],
      },
    },
  ],
}));

// --- Tool handlers ---

function arg<T = string>(
  args: Record<string, unknown> | undefined,
  key: string
): T | undefined {
  return args?.[key] as T | undefined;
}

function reqArg<T = string>(
  args: Record<string, unknown> | undefined,
  key: string
): T {
  const val = args?.[key];
  if (val === undefined) throw new Error(`Missing required argument: ${key}`);
  return val as T;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "start_session": {
        const result = await startSession({
          maxNewCardsPerSession: arg<number>(args, "maxNewCards"),
          maxReviewCardsPerSession: arg<number>(args, "maxReviewCards"),
          practiceFirstMode: arg<boolean>(args, "practiceFirst"),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sessionId: result.id,
                queueLength: result.queue.length,
                queue: result.queue,
              }),
            },
          ],
        };
      }

      case "get_next_card": {
        const card = await getNextCard(reqArg(args, "sessionId"));
        return {
          content: [
            {
              type: "text",
              text: card
                ? JSON.stringify({
                    id: card.id,
                    front: card.front,
                    back: card.back,
                    type: card.type,
                    maturity: card.maturity,
                    tags: card.tags,
                    reps: card.reps,
                    lapses: card.lapses,
                  })
                : JSON.stringify({ done: true, message: "No more cards in queue" }),
            },
          ],
        };
      }

      case "submit_review": {
        await submitReview(
          reqArg(args, "sessionId"),
          reqArg(args, "cardId"),
          reqArg<number>(args, "rating") as Grade,
          arg<number>(args, "responseMs")
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true }) }],
        };
      }

      case "skip_card": {
        const skipped = skipCard(reqArg(args, "sessionId"));
        return {
          content: [
            { type: "text", text: JSON.stringify({ skipped }) },
          ],
        };
      }

      case "adjust_session": {
        const adjusted = await adjustSession(reqArg(args, "sessionId"), {
          maxCards: arg<number>(args, "maxCards"),
          focusDeck: arg(args, "focusDeck"),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                remainingCards: adjusted.queue.length,
                queue: adjusted.queue,
              }),
            },
          ],
        };
      }

      case "get_stats": {
        const stats = await getFullStats();
        return {
          content: [{ type: "text", text: JSON.stringify(stats) }],
        };
      }

      case "list_decks": {
        const decks = await listDecks();
        const decksWithStats = await Promise.all(
          decks.map(async (d) => ({
            ...d,
            stats: await getDeckStats(d.id),
          }))
        );
        return {
          content: [{ type: "text", text: JSON.stringify(decksWithStats) }],
        };
      }

      case "get_deck_stats": {
        const stats = await getDeckStats(reqArg(args, "deckId"));
        return {
          content: [{ type: "text", text: JSON.stringify(stats) }],
        };
      }

      case "delete_deck": {
        const result = await deleteDeck(reqArg(args, "deckId"));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ deleted: true, deletedCards: result.deletedCards }),
            },
          ],
        };
      }

      case "create_card": {
        const result = await createCard({
          deckId: reqArg(args, "deckId"),
          front: reqArg(args, "front"),
          back: reqArg(args, "back"),
          tags: arg<string[]>(args, "tags"),
          type: arg(args, "type") as "guided" | "unguided" | undefined,
          checkDuplicates: true,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                card: {
                  id: result.card.id,
                  front: result.card.front,
                  back: result.card.back,
                },
                duplicateWarning: result.duplicateWarning,
              }),
            },
          ],
        };
      }

      case "get_card": {
        const card = await getCard(reqArg(args, "cardId"));
        if (!card) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Card not found" }) }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: card.id,
                deckId: card.deckId,
                front: card.front,
                back: card.back,
                tags: card.tags,
                type: card.type,
                maturity: card.maturity,
                state: card.state,
                reps: card.reps,
                lapses: card.lapses,
                stability: card.stability,
                due: card.due,
                suspended: card.suspended,
              }),
            },
          ],
        };
      }

      case "update_card": {
        const updates: Record<string, string> = {};
        const front = arg(args, "front");
        const back = arg(args, "back");
        const tags = arg(args, "tags");
        if (front) updates.front = front;
        if (back) updates.back = back;
        if (tags !== undefined) updates.tags = tags;
        const updated = await updateCard(reqArg(args, "cardId"), updates);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: updated.id,
                front: updated.front,
                back: updated.back,
                tags: updated.tags,
              }),
            },
          ],
        };
      }

      case "delete_card": {
        await deleteCard(reqArg(args, "cardId"));
        return {
          content: [{ type: "text", text: JSON.stringify({ deleted: true }) }],
        };
      }

      case "unsuspend_card": {
        const card = await unsuspendCard(reqArg(args, "cardId"));
        return {
          content: [{ type: "text", text: JSON.stringify({ suspended: card.suspended }) }],
        };
      }

      case "suspend_card": {
        const card = await suspendCard(reqArg(args, "cardId"));
        return {
          content: [{ type: "text", text: JSON.stringify({ suspended: card.suspended }) }],
        };
      }

      case "list_cards": {
        const cards = await listCards({
          deckId: arg(args, "deckId"),
          tagFilter: arg(args, "tagFilter"),
          limit: arg<number>(args, "limit"),
          offset: arg<number>(args, "offset"),
        });
        const trunc = (s: string): string =>
          s.length > 120 ? s.slice(0, 120) + "…" : s;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                count: cards.length,
                cards: cards.map((c) => ({
                  id: c.id,
                  deckId: c.deckId,
                  front: trunc(c.front),
                  back: trunc(c.back),
                  tags: parseTags(c.tags),
                  maturity: c.maturity,
                  lapses: c.lapses,
                })),
              }),
            },
          ],
        };
      }

      case "delete_cards": {
        const res = await deleteCards(reqArg<string[]>(args, "cardIds"));
        return {
          content: [{ type: "text", text: JSON.stringify(res) }],
        };
      }

      case "search_cards": {
        const results = await searchCards(reqArg(args, "query"), {
          deckId: arg(args, "deckId"),
          tags: arg<string[]>(args, "tags"),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                results.map((c) => ({
                  id: c.id,
                  front: c.front,
                  back: c.back,
                  tags: c.tags,
                  maturity: c.maturity,
                  state: c.state,
                }))
              ),
            },
          ],
        };
      }

      case "get_due_cards": {
        const dueCards = await getDueCards(30);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                count: dueCards.length,
                cards: dueCards.map((c) => ({
                  id: c.id,
                  front: c.front.slice(0, 80),
                  deck: c.deck.name,
                  state: c.state,
                  maturity: c.maturity,
                })),
              }),
            },
          ],
        };
      }

      case "get_session_history": {
        const history = await getSessionHistory(arg<number>(args, "limit") ?? 10);
        return {
          content: [{ type: "text", text: JSON.stringify(history) }],
        };
      }

      case "find_similar_cards": {
        const similar = await findSimilar(reqArg(args, "text"), {
          deckId: arg(args, "deckId"),
          cosineThreshold: arg<number>(args, "threshold"),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                count: similar.length,
                cards: similar.slice(0, 10).map((c) => ({
                  id: c.id,
                  front: c.front,
                  similarity: `${(c.similarity * 100).toFixed(0)}%`,
                })),
              }),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
