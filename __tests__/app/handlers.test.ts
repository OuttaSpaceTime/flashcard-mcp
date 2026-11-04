import { describe, it, expect, beforeEach, vi } from "vitest";
import { State } from "ts-fsrs";
import { createHandlers, toAppCard } from "../../src/app/handlers.js";
import { dispatch } from "../../src/app/server.js";
import { bucketWeek } from "../../src/core/overview.js";
import { localDay } from "../../src/core/days.js";
import { createCard, createCodeCard, updateCard, updateCodeCard } from "../../src/core/card-service.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { GradeCall } from "../../src/core/grading.js";

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

// The grades sent, and how many were aborted before an answer came.
const sent: string[] = [];
let aborted = 0;
const fakeGrade: GradeCall = async (body, signal) => {
  sent.push(body.messages[0].content as string);
  // "slowly" waits to be aborted; anything else answers at once.
  if ((body.messages[0].content as string).includes("slowly")) {
    await new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => {
        aborted++;
        reject(new Error("aborted"));
      })
    );
  }
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: JSON.stringify({ rating: 3, reason: "Correct." }) }],
    stop_reason: "end_turn",
  } as Anthropic.Messages.Message;
};

describe("app handlers", () => {
  const h = createHandlers({ gradeCall: fakeGrade });

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

  it("undoes a review, serves its card again, and redoes it with the same rating", async () => {
    await seed(2, { state: State.Review, due: new Date(Date.now() - 60_000) });
    const h = createHandlers();
    const s = (await h.startSession({})) as { sessionId: string };
    const first = (await h.nextCard({ sessionId: s.sessionId })) as { card: { id: string } };
    await h.review({ sessionId: s.sessionId, cardId: first.card.id, rating: 2 });

    expect(await h.undoReview({ sessionId: s.sessionId })).toEqual({ cardId: first.card.id, rating: 2 });
    expect(await getDb().review.count()).toBe(0);
    const again = (await h.nextCard({ sessionId: s.sessionId })) as { card: { id: string }; position: number };
    expect(again.card.id).toBe(first.card.id);
    expect(again.position).toBe(1);

    await h.review({ sessionId: s.sessionId, cardId: first.card.id, rating: 2 });
    expect(await getDb().review.count()).toBe(1);
    expect(await h.undoReview({ sessionId: s.sessionId })).toEqual({ cardId: first.card.id, rating: 2 });
    expect(await h.undoReview({ sessionId: s.sessionId })).toBeNull();
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

  it("grades, and the next card or the session's end aborts a grade still running", async () => {
    await seed(2, { state: State.Review });
    const s = (await h.startSession({})) as { sessionId: string };
    const first = (await h.nextCard({ sessionId: s.sessionId })) as { card: { id: string } };
    const g = (await h.grade({ cardId: first.card.id, answer: "Answer 1" })) as { rating: number; reason: string };
    expect(g).toMatchObject({ rating: 3, reason: "Correct." });
    aborted = 0;
    const slow = h.grade({ cardId: first.card.id, answer: "slowly" });
    await vi.waitFor(() => expect(sent.at(-1)).toContain("slowly"));
    const next = (await h.nextCard({ sessionId: s.sessionId })) as { card: { id: string } };
    await expect(slow).rejects.toThrow(/cancelled/);
    expect(aborted).toBe(1);
    const slow2 = h.grade({ cardId: next.card.id, answer: "slowly again" });
    await vi.waitFor(() => expect(sent.at(-1)).toContain("slowly again"));
    await h.endSession({ sessionId: s.sessionId });
    await expect(slow2).rejects.toThrow(/cancelled/);
    expect(aborted).toBe(2);
  });

  it("refuses to grade an empty answer without calling the API", async () => {
    const [card] = await seed(1);
    sent.length = 0;
    await expect(h.grade({ cardId: card.id, answer: "  " })).rejects.toThrow(/empty/);
    expect(sent).toHaveLength(0);
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

describe("code cards", () => {
  const h = createHandlers({ gradeCall: fakeGrade });
  const call = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => h[method](params);

  beforeEach(async () => {
    deckId = (await createDeck("Web")).id;
  });

  const exercise = {
    kind: "fill" as const,
    lang: "ruby" as const,
    brief: "Double it.",
    source: "def double(n) = n * {{c1::2}}",
    cases: [{ expr: "double(2)", goal: "4" }],
    explain: "Multiplying doubles.",
  };

  async function codeCard(): Promise<string> {
    const { card } = await createCodeCard({ deckId, exercise });
    return card.id;
  }

  it("a card reaches the app with what to draw, and not the answer", async () => {
    const cardId = await codeCard();
    const session = (await call("startSession")) as { sessionId: string };
    const next = (await call("nextCard", { sessionId: session.sessionId })) as {
      card: { id: string; front: string; exercise: { kind: string; parts: unknown[]; answers: number } };
    };
    expect(next.card.id).toBe(cardId);
    expect(next.card.exercise.kind).toBe("fill");
    expect(next.card.exercise.answers).toBe(1);
    expect(JSON.stringify(next.card.exercise)).not.toContain("{{c1::");
    expect(next.card.front).toContain("[...]");
    expect(next.card.front).not.toContain("{{c1::");
  });

  it("an ordinary card has no exercise", async () => {
    await seed(1);
    const session = (await call("startSession")) as { sessionId: string };
    const next = (await call("nextCard", { sessionId: session.sessionId })) as { card: { exercise: unknown } };
    expect(next.card.exercise).toBeNull();
  });

  it("a code card's blanks are hidden on the front and shown on the back", async () => {
    await codeCard();
    const card = await getDb().card.findFirstOrThrow({ where: { exercise: { not: null } } });
    expect(toAppCard(card, "Deck").front).toContain("n * [...]");
    expect(toAppCard(card, "Deck").back).toContain("n * <b>2</b>");
  });

  it("clozes are refused on every other way a card is written", async () => {
    await expect(createCard({ deckId, front: "An origin is {{c1::this}}.", back: "B" })).rejects.toThrow(/only a code card/);
    await expect(createCard({ deckId, front: "<pre><code>{{c1::x}}</code></pre>", back: "B" })).rejects.toThrow(/only a code card/);
    await expect(createCard({ deckId, front: "Q?", back: "{{c1::A}}" })).rejects.toThrow(/only a code card/);
    const plain = (await seed(1))[0];
    await expect(updateCard(plain.id, { front: "Now {{c1::a cloze}}." })).rejects.toThrow(/only a code card/);
    await expect(updateCard(plain.id, { back: "{{c1::x}}" })).rejects.toThrow(/only a code card/);
    expect(await getDb().card.count({ where: { exercise: null, front: { contains: "{{c1::" } } })).toBe(0);
  });

  it("runExercise answers with the verdict and the rating", async () => {
    const cardId = await codeCard();
    const right = (await call("runExercise", { cardId, answers: ["2"] })) as { status: string; rating: number };
    expect(right.status).toBe("pass");
    expect(right.rating).toBe(3);
    const wrong = (await call("runExercise", { cardId, answers: ["3"] })) as { status: string; rating: unknown };
    expect(wrong.status).toBe("wrong");
    expect(wrong.rating).toBeNull();
  });

  it("a newer runExercise stops the one before it", async () => {
    const cardId = await codeCard();
    const stuck = call("runExercise", { cardId, answers: ["loop {}"] }) as Promise<{ status: string; durationMs: number }>;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const latest = (await call("runExercise", { cardId, answers: ["2"] })) as { status: string };
    expect(latest.status).toBe("pass");
    const first = await stuck;
    expect(first.status).toBe("timeout");
    expect(first.durationMs).toBeLessThan(2000);
  });

  it("revealExercise gives the solution and rates Again", async () => {
    const cardId = await codeCard();
    const res = (await call("revealExercise", { cardId })) as { answers: string[]; rating: number };
    expect(res.answers).toEqual(["2"]);
    expect(res.rating).toBe(1);
  });

  it("refuses them on an ordinary card", async () => {
    const card = (await seed(1))[0];
    await expect(call("runExercise", { cardId: card.id, answers: [] })).rejects.toThrow(/Not a code card/);
  });

  it("a code card's sides are written only from its exercise", async () => {
    const cardId = await codeCard();
    await expect(updateCard(cardId, { back: "something else" })).rejects.toThrow(/update_code_card/);
    await expect(updateCard(cardId, { tags: "ruby" })).resolves.toBeDefined();
    const changed = await updateCodeCard(cardId, { ...exercise, explain: "Better." });
    expect(changed.back).toBe("Better.");
  });

  it("a card can't change between the kinds of Anki note it would need", async () => {
    const plain = (await seed(1))[0];
    await expect(updateCodeCard(plain.id, exercise)).rejects.toThrow(/inheritFrom/);
    const cardId = await codeCard();
    await expect(updateCodeCard(cardId, { ...exercise, kind: "compose" })).rejects.toThrow(/inheritFrom/);
  });
});
