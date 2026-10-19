import type { Card as PrismaCard, CardNote } from "@prisma/client";
import type { Grade } from "ts-fsrs";
import { getDb } from "../db/client.js";
import {
  startSession,
  getNextCard,
  getQueuePosition,
  submitReview,
  previewSchedules,
  skipCard,
  endSession,
} from "../core/session-service.js";
import { checkPressure } from "../core/pressure.js";
import { deleteCard, getCard, searchCards } from "../core/card-service.js";
import { deferLeech, findUnresolvedLeeches, leechPayload } from "../core/leeches.js";
import { parseTags } from "../core/types.js";
import { Grader, type ClaudeStarter } from "../core/grading.js";
import { getOverview } from "./overview.js";
import { recentSessions } from "./sessions.js";
import { listCardNotes, setCardNote } from "../core/card-notes.js";
import { localDay } from "../core/days.js";

/**
 * What the Omvida app can ask of the deck: the /study loop's MCP tools, reshaped
 * for a GUI that holds one long-lived connection (src/app/server.ts) rather than
 * a chat that calls a tool per step.
 *
 * Two things differ from the MCP tools on purpose:
 * - `startSession` derives `maxNewCards` from the pressure verdict itself
 *   (ok -> default, warn/pause -> 0), exactly as /study's Phase 2 table says,
 *   so the app cannot forget the rule.
 * - `nextCard` turns the leech block into data instead of an error. The MCP tool
 *   throws, because for Claude the error message is the instruction; the app
 *   needs the blocking card itself, to show it with the four ways out.
 * - `nextCard` also carries `schedules`, what each rating 1-4 would schedule
 *   (submitReview's shape, keyed by rating), so the rating keys can say where
 *   they send the card. /study has no keys to label.
 * - `grade` suggests a rating from `claude -p` (core/grading.ts), and the
 *   session drives its processes: `nextCard` ends the last card's grade and
 *   makes sure a spare claude is booted, `endSession` ends both. So a card
 *   rated without waiting for Claude leaves no grade running, and the app has
 *   no lifecycle of its own to keep.
 *
 * The app talks to one server for its whole life rather than running the CLI
 * per call: a start costs about a second, and session-service caches open
 * sessions in memory (their queues are saved in StudySession.queueState, so a
 * restarted server resumes them).
 */

export const STATE_NAMES = ["new", "learning", "review", "relearning"] as const;

export interface AppCard {
  id: string;
  deck: string;
  front: string;
  back: string;
  tags: string[];
  state: (typeof STATE_NAMES)[number];
  reps: number;
  lapses: number;
  /** Local calendar day the card is due. */
  dueDay: string;
  suspended: boolean;
}

export function toAppCard(card: PrismaCard, deckNames: Map<string, string>): AppCard {
  return {
    id: card.id,
    deck: deckNames.get(card.deckId) ?? "",
    front: card.front,
    back: card.back,
    tags: parseTags(card.tags),
    state: STATE_NAMES[card.state] ?? "new",
    reps: card.reps,
    lapses: card.lapses,
    dueDay: localDay(card.due),
    suspended: card.suspended,
  };
}

/** A card note as the app gets it (card-notes.ts). */
export function toAppNote(note: CardNote): { cardId: string; body: string; createdAt: string } {
  return { cardId: note.cardId, body: note.body, createdAt: note.createdAt.toISOString() };
}

/** The stamp's notes part: count and newest edit of the card notes. */
async function notesToken(): Promise<string> {
  const n = await getDb().cardNote.aggregate({ _count: { _all: true }, _max: { updatedAt: true } });
  return `${n._count._all}:${n._max.updatedAt?.getTime() ?? 0}`;
}

/** The stamp's reviews part: count and newest of the reviews. */
async function reviewsToken(): Promise<string> {
  const r = await getDb().review.aggregate({ _count: { _all: true }, _max: { reviewedAt: true } });
  return `${r._count._all}:${r._max.reviewedAt?.getTime() ?? 0}`;
}

/** Deck id -> name. A handful of decks, so one query per call beats a join per card. */
async function deckNames(): Promise<Map<string, string>> {
  const decks = await getDb().deck.findMany({ select: { id: true, name: true } });
  return new Map(decks.map((d) => [d.id, d.name]));
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing parameter: ${key}`);
  return v;
}

function optNum(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  if (v == null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`parameter ${key} must be a number`);
  return v;
}

export type Handler = (params: Record<string, unknown>) => Promise<unknown>;

export function createHandlers(deps: { starter?: ClaudeStarter } = {}): Record<string, Handler> {
  const grader = new Grader(deps.starter);
  return {
    overview: async (p) => getOverview({ pendingLimit: optNum(p, "pendingLimit") }),

    startSession: async () => {
      const pressure = await checkPressure();
      const maxNewCards = pressure.verdict === "ok" ? undefined : 0;
      const session = await startSession({ maxNewCardsPerSession: maxNewCards });
      const queuedNew = session.queue.filter((q) => q.reason === "new_card" || q.reason === "unguided_priority").length;
      return {
        sessionId: session.id,
        total: session.queue.length,
        newCards: queuedNew,
        reviewCards: session.queue.length - queuedNew,
        maxNewCards: maxNewCards ?? null,
        newHeldBack: maxNewCards === 0 ? pressure.newAvailable : 0,
        pressure,
      };
    },

    // The last card's grade ends here (it was rated, skipped or deleted), and
    // the spare is there for the new card's first grade.
    nextCard: async (p) => {
      const sessionId = str(p, "sessionId");
      grader.endGrade();
      const leeches = await findUnresolvedLeeches();
      if (leeches.length > 0) {
        const blocked = leeches[0];
        return { blocked: { card: toAppCard(blocked, await deckNames()), lapses: blocked.lapses } };
      }
      const card = await getNextCard(sessionId);
      if (card == null) return { done: true };
      const position = await getQueuePosition(sessionId);
      const leech = leechPayload(card);
      grader.prepare();
      return {
        card: toAppCard(card, await deckNames()),
        position: position?.position ?? null,
        total: position?.total ?? null,
        repeat: position?.repeat ?? false,
        leech,
        schedules: previewSchedules(card),
      };
    },

    // The process is claimed before the card lookup awaits, so overlapping
    // grades keep the order they came in (Grader).
    grade: async (p) => {
      const cardId = str(p, "cardId");
      const answer = typeof p.answer === "string" ? p.answer : "";
      if (answer.trim() === "") throw new Error("nothing to grade: the answer is empty");
      const proc = grader.claim();
      const card = await getCard(cardId);
      if (card == null) {
        proc.kill();
        throw new Error(`Card not found: ${cardId}`);
      }
      return grader.grade(proc, { front: card.front, back: card.back, answer });
    },

    review: async (p) => {
      const rating = p.rating;
      if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) {
        throw new Error("rating must be 1, 2, 3 or 4");
      }
      return submitReview(str(p, "sessionId"), str(p, "cardId"), rating as Grade, optNum(p, "responseMs"));
    },

    skip: async (p) => ({ skipped: await skipCard(str(p, "sessionId")) }),

    endSession: async (p) => {
      grader.close();
      const ended = await endSession(str(p, "sessionId"));
      if (ended == null) return null;
      return {
        id: ended.id,
        startTime: ended.startTime.toISOString(),
        endTime: ended.endTime?.toISOString() ?? null,
        cardsReviewed: ended.cardsReviewed,
        newCards: ended.newCards,
        accuracy: ended.accuracy,
      };
    },

    resolveLeech: async (p) => {
      const card = await deferLeech(str(p, "cardId"));
      return { cardId: card.id, deferredAtLapses: card.leechDeferredLapses };
    },

    deleteCard: async (p) => {
      await deleteCard(str(p, "cardId"));
      return { deleted: true };
    },

    /** Every card, newest first: hundreds, small enough to ship whole. */
    cards: async () => {
      const [rows, names] = await Promise.all([
        getDb().card.findMany({ orderBy: { createdAt: "desc" } }),
        deckNames(),
      ]);
      return rows.map((c) => toAppCard(c, names));
    },

    /**
     * A token that changes whenever a card is created, edited or deleted, by
     * this server or any other process on the same database (Claude Code's MCP
     * server, the CLI). The app polls it to notice a card fixed in Claude Code
     * without reloading the whole deck every few seconds. Count plus newest
     * updatedAt: an edit moves the max (Prisma's @updatedAt), a delete moves
     * the count. A review does not move it: it writes the card's scheduling
     * and keeps its updatedAt (session-service.ts), so mid-session the app
     * reloads the deck for a card fixed in Claude Code, not for every rating.
     * Not `PRAGMA data_version`, which would skip our own writes but is per
     * connection, and the Prisma adapter owns those.
     *
     * Reviews and card notes have tokens of their own, `reviews` and
     * `notes`, made the same way. Reviews, from this app or a /study chat,
     * move the due counts and the cards' scheduling, which the app reloads on
     * its own terms. A fix session resolving a note (a delete) must show as
     * surely as the card it fixed, and apart, so a note saved reloads only
     * the notes.
     */
    stamp: async () => {
      const [cards, reviews, notes] = await Promise.all([
        getDb().card.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
        reviewsToken(),
        notesToken(),
      ]);
      return { stamp: `${cards._count._all}:${cards._max.updatedAt?.getTime() ?? 0}`, reviews, notes };
    },

    /** Every open card note (card-notes.ts), oldest first. */
    notes: async () => (await listCardNotes()).map(toAppNote),

    /** Writes a card's note; an empty body deletes it. */
    setNote: async (p) => {
      const body = typeof p.body === "string" ? p.body : "";
      const note = await setCardNote(str(p, "cardId"), body);
      return note == null ? null : toAppNote(note);
    },

    /** Recent sessions with the cards each lapsed and noted (sessions.ts). */
    sessions: async (p) => recentSessions(optNum(p, "limit") ?? 5),

    searchCards: async (p) => {
      const query = typeof p.query === "string" ? p.query.trim() : "";
      if (query === "") return [];
      const [found, names] = await Promise.all([searchCards(query), deckNames()]);
      return found.slice(0, optNum(p, "limit") ?? 20).map((c) => toAppCard(c, names));
    },

    /**
     * Card ids from the newest `limit` reviews, deduplicated, newest first, with
     * the local day each was last reviewed: the dashboard ranks wiki pages by it.
     */
    recentlyStudied: async (p) => {
      const newest = await getDb().review.findMany({
        select: { cardId: true, reviewedAt: true },
        orderBy: { reviewedAt: "desc" },
        take: optNum(p, "limit") ?? 100,
      });
      const latest = new Map<string, Date>();
      for (const r of newest) if (!latest.has(r.cardId)) latest.set(r.cardId, r.reviewedAt);
      return [...latest].map(([id, at]) => ({ id, at: localDay(at) }));
    },
  };
}
