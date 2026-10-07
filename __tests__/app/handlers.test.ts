import { describe, it, expect, beforeEach } from "vitest";
import { State } from "ts-fsrs";
import { createHandlers } from "../../src/app/handlers.js";
import { dispatch } from "../../src/app/server.js";
import { bucketWeek } from "../../src/app/overview.js";
import { localDay } from "../../src/core/days.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";
import type { ClaudeRunner } from "../../src/core/grading.js";

let deckId: string;

async function seed(count: number, overrides: Partial<{ state: number; due: Date; lapses: number; front: string }> = {}) {
  const db = getDb();
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(
      await db.card.create({
        data: {
          deckId,
          front: overrides.front ?? `Question ${i + 1}`,
          back: `Answer ${i + 1}`,
          tags: "http,web",
          state: overrides.state ?? State.New,
          due: overrides.due ?? new Date(Date.now() - 60_000),
          lapses: overrides.lapses ?? 0,
          stability: overrides.state === State.Review ? 5 : 0,
          lastReview: overrides.state === State.Review ? new Date(Date.now() - 6 * 86400_000) : null,
          interval: overrides.state === State.Review ? 5 : 0,
          // Yesterday, so seeding does not count as today's intake (pressure's second axis).
          createdAt: new Date(Date.now() - 86400_000),
        },
      })
    );
  }
  return out;
}

const fakeGrader: ClaudeRunner = async () => ({
  code: 0,
  stdout: JSON.stringify({ is_error: false, structured_output: { rating: 3, reason: "Correct.", quality_issue: "none" } }),
  stderr: "",
});

describe("app handlers", () => {
  const h = createHandlers({ runner: fakeGrader });

  beforeEach(async () => {
    deckId = (await createDeck("Web")).id;
  });

  it("holds new cards back when pressure is not ok, as /study's Phase 2 table says", async () => {
    await seed(25, { state: State.Review });
    await seed(3);
    const s = (await h.startSession({})) as { pressure: { verdict: string }; maxNewCards: number; newCards: number; newHeldBack: number };
    expect(s.pressure.verdict).toBe("warn");
    expect(s.maxNewCards).toBe(0);
    expect(s.newCards).toBe(0);
    expect(s.newHeldBack).toBe(3);
  });

  it("takes new cards at the default when pressure is ok", async () => {
    await seed(3);
    const ok = (await h.startSession({})) as { maxNewCards: number | null; newCards: number };
    expect(ok.maxNewCards).toBeNull();
    expect(ok.newCards).toBe(3);
  });

  it("serves a card with its position, reviews it, and reports done at the end", async () => {
    await seed(1, { state: State.Review });
    const s = (await h.startSession({})) as { sessionId: string };
    const next = (await h.nextCard({ sessionId: s.sessionId })) as {
      card: { id: string; deck: string; tags: string[]; state: string };
      position: number;
      total: number;
    };
    expect(next.position).toBe(1);
    expect(next.total).toBe(1);
    expect(next.card.deck).toBe("Web");
    expect(next.card.tags).toEqual(["http", "web"]);
    expect(next.card.state).toBe("review");

    const sched = (await h.review({ sessionId: s.sessionId, cardId: next.card.id, rating: 3 })) as { interval: number };
    expect(sched.interval).toBeGreaterThanOrEqual(1);
    expect(await h.nextCard({ sessionId: s.sessionId })).toEqual({ done: true });

    const ended = (await h.endSession({ sessionId: s.sessionId })) as { cardsReviewed: number; endTime: string };
    expect(ended.cardsReviewed).toBe(1);
    expect(ended.endTime).not.toBeNull();
  });

  it("returns a leech block as data, and lifts it on resolveLeech", async () => {
    const [leech] = await seed(1, { state: State.Review, lapses: 6 });
    await seed(1, { state: State.Review });
    const s = (await h.startSession({})) as { sessionId: string };
    // The queue is ordered by retrievability, so serve until the leech comes up.
    let served = (await h.nextCard({ sessionId: s.sessionId })) as { card: { id: string }; leech: unknown };
    if (served.card.id !== leech.id) {
      await h.review({ sessionId: s.sessionId, cardId: served.card.id, rating: 3 });
      served = (await h.nextCard({ sessionId: s.sessionId })) as typeof served;
    }
    expect(served.card.id).toBe(leech.id);
    expect(served.leech).toEqual({ lapses: 6, mustResolve: true });
    await h.review({ sessionId: s.sessionId, cardId: leech.id, rating: 1 });

    const blocked = (await h.nextCard({ sessionId: s.sessionId })) as { blocked: { card: { id: string }; lapses: number } };
    expect(blocked.blocked.card.id).toBe(leech.id);

    await h.resolveLeech({ cardId: leech.id });
    const after = (await h.nextCard({ sessionId: s.sessionId })) as { blocked?: unknown };
    expect(after.blocked).toBeUndefined();
  });

  it("names each card's deck", async () => {
    await seed(1);
    const all = (await h.cards({})) as { deck: string }[];
    expect(all.map((c) => c.deck)).toEqual(["Web"]);
    const found = (await h.searchCards({ query: "Question" })) as { deck: string }[];
    expect(found[0].deck).toBe("Web");
  });

  it("grades through the injected runner", async () => {
    const [card] = await seed(1);
    const g = (await h.grade({ cardId: card.id, answer: "Answer 1" })) as { rating: number; reason: string };
    expect(g).toMatchObject({ rating: 3, reason: "Correct." });
  });

  it("rejects a rating outside 1-4", async () => {
    const [card] = await seed(1);
    await expect(h.review({ sessionId: "x", cardId: card.id, rating: 5 })).rejects.toThrow(/1, 2, 3 or 4/);
  });

  it("lists recently studied cards newest first, once each", async () => {
    const [a, b] = await seed(2);
    const db = getDb();
    const t = Date.now();
    await db.review.create({ data: { cardId: a.id, rating: 3, stability: 1, difficulty: 5, elapsedDays: 0, reviewedAt: new Date(t - 3000) } });
    await db.review.create({ data: { cardId: b.id, rating: 3, stability: 1, difficulty: 5, elapsedDays: 0, reviewedAt: new Date(t - 2000) } });
    await db.review.create({ data: { cardId: a.id, rating: 3, stability: 1, difficulty: 5, elapsedDays: 0, reviewedAt: new Date(t - 1000) } });
    const out = (await h.recentlyStudied({})) as { id: string }[];
    expect(out.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("builds an overview: pending excludes new cards, maturity sums to the live deck", async () => {
    await seed(2, { state: State.Review });
    await seed(3);
    const o = (await h.overview({})) as {
      pending: unknown[];
      totalCards: number;
      maturity: Record<string, number>;
      week: unknown[];
      pressure: { flashcardsDue: number };
    };
    expect(o.pending).toHaveLength(2);
    expect(o.pressure.flashcardsDue).toBe(2);
    expect(o.totalCards).toBe(5);
    expect(Object.values(o.maturity).reduce((x, y) => x + y, 0)).toBe(5);
    expect(o.week).toHaveLength(7);
  });
});

describe("overview helpers", () => {
  it("buckets reviews into the local days ending today", () => {
    const now = new Date(2026, 9, 6, 12);
    const week = bucketWeek(
      [
        { reviewedAt: new Date(2026, 9, 6, 1), rating: 1 },
        { reviewedAt: new Date(2026, 9, 6, 23), rating: 3 },
        { reviewedAt: new Date(2026, 9, 1, 9), rating: 3 },
        { reviewedAt: new Date(2026, 8, 20, 9), rating: 3 },
      ],
      now
    );
    expect(week.map((d) => d.day)).toEqual([
      "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06",
    ]);
    expect(week[6]).toEqual({ day: "2026-10-06", reviews: 2, again: 1 });
    expect(week[1].reviews).toBe(1);
  });

  it("formats a local day", () => {
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("dispatch", () => {
  const handlers = {
    echo: async (p: Record<string, unknown>) => p,
    boom: async () => {
      throw new Error("nope");
    },
  };

  it("answers with the request id", async () => {
    expect(JSON.parse((await dispatch(handlers, '{"id":7,"method":"echo","params":{"a":1}}'))!)).toEqual({
      id: 7,
      result: { a: 1 },
    });
  });

  it("turns a handler throw into an error with the same id", async () => {
    expect(JSON.parse((await dispatch(handlers, '{"id":"x","method":"boom"}'))!)).toEqual({
      id: "x",
      error: { message: "nope" },
    });
  });

  it("rejects unknown methods, non-JSON, and inherited property names", async () => {
    expect(JSON.parse((await dispatch(handlers, '{"id":1,"method":"nope"}'))!).error.message).toMatch(/unknown method/);
    expect(JSON.parse((await dispatch(handlers, "{"))!).error.message).toMatch(/not JSON/);
    expect(JSON.parse((await dispatch(handlers, '{"id":1,"method":"toString"}'))!).error.message).toMatch(/unknown method/);
  });

  it("ignores blank lines", async () => {
    expect(await dispatch(handlers, "   ")).toBeNull();
  });
});
