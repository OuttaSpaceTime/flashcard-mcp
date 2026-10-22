import { describe, it, expect, beforeEach } from "vitest";
import { State } from "ts-fsrs";
import { createHandlers } from "../../src/app/handlers.js";
import { dispatch } from "../../src/app/server.js";
import { bucketWeek } from "../../src/core/overview.js";
import { localDay } from "../../src/core/days.js";
import { updateCard } from "../../src/core/card-service.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";
import type { ClaudeStarter } from "../../src/core/grading.js";

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

const started: string[][] = [];
let killed = 0;
const fakeGrader: ClaudeStarter = (argv) => {
  started.push(argv);
  let sent = false;
  return {
    get exited() {
      return sent;
    },
    send: async () => {
      sent = true;
      return {
        code: 0,
        stdout: JSON.stringify({ type: "result", is_error: false, structured_output: { rating: 3, reason: "Correct.", quality_issue: "none" } }),
        stderr: "",
      };
    },
    kill: () => {
      if (!sent) killed++;
    },
  };
};

describe("app handlers", () => {
  const h = createHandlers({ starter: fakeGrader });

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
      schedules: Record<string, { interval: number; intraDay: boolean }>;
    };
    expect(next.position).toBe(1);
    expect(next.total).toBe(1);
    expect(next.card.deck).toBe("Web");
    expect(next.card.tags).toEqual(["http", "web"]);
    expect(next.card.state).toBe("review");
    expect(Object.keys(next.schedules)).toEqual(["1", "2", "3", "4"]);
    expect(next.schedules[1].intraDay).toBe(true);
    expect(next.schedules[2].interval).toBeLessThanOrEqual(next.schedules[3].interval);
    expect(next.schedules[3].interval).toBeLessThanOrEqual(next.schedules[4].interval);

    const sched = (await h.review({ sessionId: s.sessionId, cardId: next.card.id, rating: 3 })) as { interval: number; intraDay: boolean };
    expect(sched.interval).toBeGreaterThanOrEqual(1);
    // The key said where the card would go, and it went there.
    expect(sched.interval).toBe(next.schedules[3].interval);
    expect(sched.intraDay).toBe(next.schedules[3].intraDay);
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

  it("moves the stamp on an edit or a delete, and not on a read", async () => {
    const [a, b] = await seed(2);
    const stamp = async () => ((await h.stamp({})) as { stamp: string }).stamp;
    const first = await stamp();
    await h.cards({});
    expect(await stamp()).toBe(first);

    // Past the millisecond the seed wrote in, so the new updatedAt is larger.
    await new Promise((r) => setTimeout(r, 5));
    await updateCard(a.id, { back: "A better answer" });
    const edited = await stamp();
    expect(edited).not.toBe(first);

    await h.deleteCard({ cardId: b.id });
    expect(await stamp()).not.toBe(edited);
  });

  it("moves the reviews token, not the cards', on a review and a leech flag", async () => {
    await seed(1, { state: State.Review, lapses: 8 });
    const stamp = async () => (await h.stamp({})) as { stamp: string; reviews: string };
    const first = await stamp();
    await new Promise((r) => setTimeout(r, 5));
    const s = (await h.startSession({})) as { sessionId: string };
    const next = (await h.nextCard({ sessionId: s.sessionId })) as { card?: { id: string }; blocked?: { card: { id: string } } };
    const id = next.card?.id ?? next.blocked!.card.id;
    expect((await stamp()).stamp).toBe(first.stamp);
    await h.review({ sessionId: s.sessionId, cardId: id, rating: 3 });
    const reviewed = await stamp();
    expect(reviewed.stamp).toBe(first.stamp);
    expect(reviewed.reviews).not.toBe(first.reviews);
  });

  it("moves the notes token, not the cards', when a note is written or resolved", async () => {
    const [a] = await seed(1);
    const stamp = async () => (await h.stamp({})) as { stamp: string; notes: string };
    const first = await stamp();
    await h.setNote({ cardId: a.id, body: "reword the front" });
    const noted = await stamp();
    expect(noted.notes).not.toBe(first.notes);
    expect(noted.stamp).toBe(first.stamp);
    await h.setNote({ cardId: a.id, body: "" });
    expect((await stamp()).notes).not.toBe(noted.notes);
  });

  it("writes, lists and clears card notes", async () => {
    const [a, b] = await seed(2);
    const saved = (await h.setNote({ cardId: b.id, body: "split it" })) as { cardId: string; body: string };
    expect(saved).toMatchObject({ cardId: b.id, body: "split it" });
    await h.setNote({ cardId: a.id, body: "why?" });
    const notes = (await h.notes({})) as { cardId: string; body: string }[];
    expect(notes.map((n) => n.cardId)).toEqual([b.id, a.id]);
    expect(await h.setNote({ cardId: b.id, body: "  " })).toBeNull();
    expect(((await h.notes({})) as unknown[]).length).toBe(1);
    await expect(h.setNote({ body: "x" })).rejects.toThrow(/cardId/);
  });

  it("lists recent sessions with what each lapsed and noted, by time window", async () => {
    const [a, b, c] = await seed(3, { state: State.Review });
    const db = getDb();
    const t = Date.now();
    const at = (ago: number) => new Date(t - ago);
    const review = (cardId: string, rating: number, ago: number) =>
      db.review.create({ data: { cardId, rating, stability: 1, difficulty: 5, elapsedDays: 1, reviewedAt: at(ago) } });
    // An older closed session that lapsed `a` twice and `b` once; a newer one,
    // never closed, that lapsed `c`; one that reviewed nothing.
    const old = await db.studySession.create({ data: { startTime: at(100_000), endTime: at(80_000), cardsReviewed: 3, accuracy: 0 } });
    await review(a.id, 1, 95_000);
    await review(b.id, 1, 90_000);
    await review(a.id, 1, 85_000);
    const open = await db.studySession.create({ data: { startTime: at(60_000), cardsReviewed: 2, accuracy: 0.5 } });
    await review(c.id, 1, 50_000);
    await review(a.id, 3, 40_000);
    await db.studySession.create({ data: { startTime: at(10_000), cardsReviewed: 0 } });
    await db.cardNote.create({ data: { cardId: b.id, body: "x", createdAt: at(88_000) } });
    await db.cardNote.create({ data: { cardId: c.id, body: "y", createdAt: at(45_000) } });

    const out = (await h.sessions({})) as { id: string; lapses: { cardId: string; front: string }[]; noted: string[] }[];
    expect(out.map((s) => s.id)).toEqual([open.id, old.id]);
    expect(out[0].lapses.map((l) => l.cardId)).toEqual([c.id]);
    expect(out[0].noted).toEqual([c.id]);
    expect(out[1].lapses.map((l) => l.cardId)).toEqual([a.id, b.id]);
    expect(out[1].lapses[0].front).toBe("Question 1");
    expect(out[1].noted).toEqual([b.id]);
  });

  it("grades on the spare nextCard booted, keeps a spare across cards, and ends it with the session", async () => {
    await seed(2, { state: State.Review });
    const s = (await h.startSession({})) as { sessionId: string };
    await h.nextCard({ sessionId: s.sessionId });
    started.length = 0;
    killed = 0;
    const next = (await h.nextCard({ sessionId: s.sessionId })) as { card: { id: string } };
    expect(started).toHaveLength(0);   // the spare from before is still up
    const g = (await h.grade({ cardId: next.card.id, answer: "Answer 1" })) as { rating: number; reason: string };
    expect(g).toMatchObject({ rating: 3, reason: "Correct." });
    expect(started).toHaveLength(1);   // the spare for the next grade
    await h.nextCard({ sessionId: s.sessionId });
    expect(killed).toBe(0);
    await h.endSession({ sessionId: s.sessionId });
    expect(killed).toBe(1);
  });

  it("refuses to grade an empty answer without starting claude", async () => {
    const [card] = await seed(1);
    started.length = 0;
    await expect(h.grade({ cardId: card.id, answer: "  " })).rejects.toThrow(/empty/);
    expect(started).toHaveLength(0);
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

  it("builds an overview: pending excludes new cards, maturity sums to the unsuspended deck", async () => {
    await seed(2, { state: State.Review });
    await seed(3);
    const [suspended] = await seed(1, { state: State.Review });
    await getDb().card.update({ where: { id: suspended.id }, data: { suspended: true } });
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
