import type { Card as PrismaCard } from "@prisma/client";
import type { Grade } from "ts-fsrs";
import { getDb } from "../db/client.js";
import {
  startSession,
  getNextCard,
  getQueuePosition,
  submitReview,
  skipCard,
  endSession,
} from "../core/session-service.js";
import { checkPressure } from "../core/pressure.js";
import { deleteCard, getCard, searchCards } from "../core/card-service.js";
import { deferLeech, findUnresolvedLeeches, leechPayload } from "../core/leeches.js";
import { parseTags } from "../core/types.js";
import { gradeAnswer, type ClaudeRunner } from "../core/grading.js";
import { getOverview } from "./overview.js";
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

export function createHandlers(deps: { runner?: ClaudeRunner } = {}): Record<string, Handler> {
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

    nextCard: async (p) => {
      const sessionId = str(p, "sessionId");
      const leeches = await findUnresolvedLeeches();
      if (leeches.length > 0) {
        const blocked = leeches[0];
        return { blocked: { card: toAppCard(blocked, await deckNames()), lapses: blocked.lapses } };
      }
      const card = await getNextCard(sessionId);
      if (card == null) return { done: true };
      const position = await getQueuePosition(sessionId);
      const leech = leechPayload(card);
      return {
        card: toAppCard(card, await deckNames()),
        position: position?.position ?? null,
        total: position?.total ?? null,
        repeat: position?.repeat ?? false,
        leech,
      };
    },

    grade: async (p) => {
      const cardId = str(p, "cardId");
      const card = await getCard(cardId);
      if (card == null) throw new Error(`Card not found: ${cardId}`);
      const answer = typeof p.answer === "string" ? p.answer : "";
      return gradeAnswer({ front: card.front, back: card.back, answer }, deps.runner);
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
