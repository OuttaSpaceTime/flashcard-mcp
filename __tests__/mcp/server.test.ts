/**
 * The MCP tools as a client sees them: the real server from createServer(),
 * connected to an SDK Client over an in-memory transport. These pin the tool
 * payload shapes the /study and /study-flashcard skills read; the core
 * behaviour behind each tool is tested in __tests__/core.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { State } from "ts-fsrs";
import { createServer } from "../../src/mcp/server.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";

let client: Client;
let deckId: string;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** Calls a tool that must succeed and parses its JSON payload. */
async function callJson<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await call(name, args);
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0].text) as T;
}

async function seed(
  count: number,
  overrides: Partial<{ front: string; state: number; lapses: number; due: Date }> = {}
) {
  const db = getDb();
  const out = [];
  for (let i = 0; i < count; i++) {
    const review = overrides.state === State.Review;
    out.push(
      await db.card.create({
        data: {
          deckId,
          front: overrides.front ?? `Question ${i + 1}`,
          back: `Answer ${i + 1}`,
          state: overrides.state ?? State.New,
          due: overrides.due ?? new Date(Date.now() - 60_000),
          lapses: overrides.lapses ?? 0,
          stability: review ? 5 : 0,
          interval: review ? 5 : 0,
          lastReview: review ? new Date(Date.now() - 6 * 86400_000) : null,
        },
      })
    );
  }
  return out;
}

beforeEach(async () => {
  deckId = (await createDeck("MCP")).id;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
});

describe("MCP server", () => {
  it("registers 27 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(27);
  });

  it("get_next_card spreads the queue position and a leech field, then blocks", async () => {
    const [leech] = await seed(1, { state: State.Review, lapses: 8 });
    await seed(1, { state: State.Review });
    const session = await callJson<{ sessionId: string; queueLength: number }>("start_session", {});
    expect(session.queueLength).toBe(2);

    const first = await callJson<Record<string, unknown>>("get_next_card", { sessionId: session.sessionId });
    expect(first).toMatchObject({ id: leech.id, position: 1, total: 2, repeat: false, lapses: 8 });
    expect(first.leech).toEqual({ lapses: 8, mustResolve: true });

    await callJson("submit_review", { sessionId: session.sessionId, cardId: leech.id, rating: 3 });
    const blocked = await call("get_next_card", { sessionId: session.sessionId });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain(leech.id);
  });

  it("get_next_card omits leech for an ordinary card and reports done at the end", async () => {
    await seed(1);
    const { sessionId } = await callJson<{ sessionId: string }>("start_session", {});
    const card = await callJson<Record<string, unknown>>("get_next_card", { sessionId });
    expect(card).not.toHaveProperty("leech");
    await callJson("skip_card", { sessionId });
    expect(await callJson("get_next_card", { sessionId })).toEqual({ done: true, message: "No more cards in queue" });
  });

  it("get_due_cards counts every due card and previews at most 30", async () => {
    await seed(31, { front: "x".repeat(100) });
    await seed(1, { due: new Date(Date.now() + 86400_000) });
    const due = await callJson<{
      totalDue: number;
      previewCount: number;
      hasMore: boolean;
      preview: { id: string; front: string; deck: string; state: number; maturity: string }[];
    }>("get_due_cards");
    expect(due.totalDue).toBe(31);
    expect(due.previewCount).toBe(30);
    expect(due.hasMore).toBe(true);
    expect(due.preview[0]).toMatchObject({ deck: "MCP", state: State.New, maturity: "new" });
    expect(due.preview[0].front).toHaveLength(80);
  });

  it("list_cards cuts front and back at 120 characters and parses tags", async () => {
    await seed(1, { front: "y".repeat(150) });
    const listed = await callJson<{ count: number; cards: { front: string; back: string; tags: string[] }[] }>(
      "list_cards",
      { deckId }
    );
    expect(listed.count).toBe(1);
    expect(listed.cards[0].front).toBe("y".repeat(120) + "…");
    expect(listed.cards[0].back).toBe("Answer 1");
    expect(listed.cards[0].tags).toEqual([]);
  });

  it("get_card returns the card, and an error result for an unknown id", async () => {
    const [card] = await seed(1);
    const found = await callJson<{ id: string; maturity: string; state: number }>("get_card", { cardId: card.id });
    expect(found).toMatchObject({ id: card.id, maturity: "new", state: State.New });

    const missing = await call("get_card", { cardId: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("Card not found: nope");
  });

  it("end_session returns the session summary", async () => {
    const [card] = await seed(1);
    const { sessionId } = await callJson<{ sessionId: string }>("start_session", {});
    await callJson("get_next_card", { sessionId });
    await callJson("submit_review", { sessionId, cardId: card.id, rating: 3 });
    const summary = await callJson<Record<string, unknown>>("end_session", { sessionId });
    expect(summary).toMatchObject({ id: sessionId, cardsReviewed: 1, newCards: 1, accuracy: 1 });
    expect(typeof summary.startTime).toBe("string");
    expect(typeof summary.endTime).toBe("string");
    expect(await callJson("end_session", { sessionId: "unknown" })).toBeNull();
  });

  it("rejects arguments that fail the input schema", async () => {
    const result = await call("submit_review", { sessionId: "s", cardId: "c", rating: 5 });
    expect(result.isError).toBe(true);
  });
});
