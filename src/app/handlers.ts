import type { Card as PrismaCard, CardNote } from "@prisma/client";
import { isGrade } from "../core/scheduler.js";
import {
  startSession,
  getNextCardOrBlock,
  getQueuePosition,
  submitReview,
  undoLastReview,
  previewSchedules,
  skipCard,
  endSession,
} from "../core/session-service.js";
import { checkPressure } from "../core/pressure.js";
import { allCards, deleteCard, getCard, getCodeCardExercise, searchCards } from "../core/card-service.js";
import { deckNames } from "../core/deck-service.js";
import { recentlyStudied } from "../core/analytics-service.js";
import { changeTokens } from "../core/change-tokens.js";
import { deferLeech, leechPayload } from "../core/leeches.js";
import { CARD_STATE_NAMES, parseTags, type CardStateName } from "../core/types.js";
import { Grader, type GradeCall } from "../core/grading.js";
import { getOverview } from "../core/overview.js";
import { recentSessions } from "../core/recent-sessions.js";
import { listCardNotes, setCardNote } from "../core/card-notes.js";
import { localDay } from "../core/days.js";
import { clozeSides } from "../core/cloze.js";
import { exerciseView, parseExercise, revealExercise, runExercise, type ExerciseView } from "../core/exercises.js";

/**
 * What the Omvida app can ask of the deck: the /study loop's MCP tools, reshaped
 * for a GUI that holds one long-lived connection (src/app/server.ts) rather than
 * a chat that calls a tool per step.
 *
 * These things differ from the MCP tools on purpose:
 * - `startSession` derives `maxNewCards` from the pressure verdict itself
 *   (ok -> default, warn/pause -> 0), exactly as /study's Phase 2 table says,
 *   so the app cannot forget the rule.
 * - `nextCard` returns the leech block as data (core getNextCardOrBlock)
 *   instead of an error. The MCP tool throws, because for Claude the error
 *   message is the instruction; the app needs the blocking card itself, to
 *   show it with the four ways out.
 * - `nextCard` also carries `schedules`, what each rating 1-4 would schedule
 *   (submitReview's shape, keyed by rating), so the rating keys can say where
 *   they send the card. /study has no keys to label.
 * - `grade` suggests a rating from the Claude API (core/grading.ts), and the
 *   session ends its requests: `nextCard` and `endSession` abort the last
 *   card's grade. So a card rated without waiting for Claude leaves no grade
 *   running, and the app has no lifecycle of its own to keep. /study grades
 *   in the chat instead.
 * - App-only reads with no MCP tool: `overview`, `cards` (the whole deck),
 *   `stamp` (change tokens to poll), `notes`/`setNote`, `sessions`,
 *   `recentlyStudied`.
 *
 * Each method is a thin call into core; this file only reshapes results.
 *
 * The app talks to one server for its whole life rather than running the CLI
 * per call: a start costs about a second, and session-service caches open
 * sessions in memory (their queues are saved in StudySession.queueState, so a
 * restarted server resumes them).
 */

export interface AppCard {
  id: string;
  deck: string;
  front: string;
  back: string;
  tags: string[];
  state: CardStateName;
  reps: number;
  lapses: number;
  /** Local calendar day the card is due. */
  dueDay: string;
  suspended: boolean;
  /** How a code card is drawn, or null on any other card. */
  exercise: ExerciseView | null;
}

// The sides as they read. A code card's blanks are hidden on the front and shown
// on the back, so the app's every view of a card needs no idea of clozes.
export function toAppCard(card: PrismaCard, deck: string): AppCard {
  const exercise = parseExercise(card.exercise);
  return {
    id: card.id,
    deck,
    ...(exercise == null ? { front: card.front, back: card.back } : clozeSides(card.front, card.back)),
    tags: parseTags(card.tags),
    state: CARD_STATE_NAMES[card.state] ?? "new",
    reps: card.reps,
    lapses: card.lapses,
    dueDay: localDay(card.due),
    suspended: card.suspended,
    exercise: exercise == null ? null : exerciseView(exercise),
  };
}

/** A card note as the app gets it (card-notes.ts). */
export function toAppNote(note: CardNote): { cardId: string; body: string; createdAt: string } {
  return { cardId: note.cardId, body: note.body, createdAt: note.createdAt.toISOString() };
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

export function createHandlers(deps: { gradeCall?: GradeCall } = {}): Record<string, Handler> {
  const grader = new Grader(deps.gradeCall);
  let latestRun: AbortController | null = null;
  return {
    overview: async (p) => getOverview({ pendingLimit: optNum(p, "pendingLimit") }),

    startSession: async () => {
      const pressure = await checkPressure();
      const maxNewCards = pressure.verdict === "ok" ? undefined : 0;
      const session = await startSession({ maxNewCardsPerSession: maxNewCards });
      return {
        sessionId: session.id,
        total: session.queue.length,
        newCards: session.newCount,
        reviewCards: session.reviewCount,
        maxNewCards: maxNewCards ?? null,
        newHeldBack: maxNewCards === 0 ? pressure.newAvailable : 0,
        pressure,
      };
    },

    // The last card's grade ends here: it was rated, skipped or deleted.
    nextCard: async (p) => {
      const sessionId = str(p, "sessionId");
      grader.endGrade();
      const [next, names] = await Promise.all([getNextCardOrBlock(sessionId), deckNames()]);
      if (next == null) return { done: true };
      if ("blocked" in next) {
        const blocked = next.blocked[0];
        return { blocked: { card: toAppCard(blocked, names.get(blocked.deckId) ?? ""), lapses: blocked.lapses } };
      }
      const { card } = next;
      const position = await getQueuePosition(sessionId);
      const leech = leechPayload(card);
      return {
        card: toAppCard(card, names.get(card.deckId) ?? ""),
        position: position?.position ?? null,
        total: position?.total ?? null,
        repeat: position?.repeat ?? false,
        leech,
        schedules: await previewSchedules(card),
      };
    },

    // The grade is claimed before the card lookup awaits, so overlapping
    // grades keep the order they came in (Grader).
    grade: async (p) => {
      const cardId = str(p, "cardId");
      const answer = typeof p.answer === "string" ? p.answer : "";
      if (answer.trim() === "") throw new Error("nothing to grade: the answer is empty");
      const claim = grader.claim();
      const card = await getCard(cardId);
      if (card == null) {
        claim.abort();
        throw new Error(`Card not found: ${cardId}`);
      }
      return grader.grade(claim, { front: card.front, back: card.back, answer });
    },

    review: async (p) => {
      const rating = p.rating;
      if (!isGrade(rating)) throw new Error("rating must be 1, 2, 3 or 4");
      return submitReview(str(p, "sessionId"), str(p, "cardId"), rating, optNum(p, "responseMs"));
    },

    // The session's newest review taken back, or null with none left. `nextCard`
    // then serves its card again. Redo is `review` with the same rating.
    undoReview: async (p) => undoLastReview(str(p, "sessionId")),

    // A code card's try: its result, and on a pass the rating to write. The app
    // shows the verdict and runs this on every pause in the typing as well, so a
    // newer run stops the last one: an endless loop being typed would otherwise
    // keep a spinning process per pause, each until the timeout. The app sends a
    // run only after dropping interest in the one before.
    runExercise: async (p) => {
      latestRun?.abort();
      const run = new AbortController();
      latestRun = run;
      const answers = Array.isArray(p.answers) ? p.answers.map(String) : [];
      return runExercise(await getCodeCardExercise(str(p, "cardId")), answers, run.signal);
    },

    // Giving up on a code card: the solution, run, and the rating that writes.
    revealExercise: async (p) => revealExercise(await getCodeCardExercise(str(p, "cardId"))),

    skip: async (p) => ({ skipped: await skipCard(str(p, "sessionId")) }),

    endSession: async (p) => {
      grader.endGrade();
      return endSession(str(p, "sessionId"));
    },

    resolveLeech: async (p) => deferLeech(str(p, "cardId")),

    deleteCard: async (p) => {
      await deleteCard(str(p, "cardId"));
      return { deleted: true };
    },

    /** Every card, newest first: hundreds, small enough to ship whole. */
    cards: async () => (await allCards()).map((c) => toAppCard(c, c.deck.name)),

    /**
     * Change tokens (core/change-tokens.ts) the app polls to notice a card,
     * review or note written by another process. `stamp` is the cards token.
     */
    stamp: async () => {
      const { cards, reviews, notes } = await changeTokens();
      return { stamp: cards, reviews, notes };
    },

    /** Every open card note (card-notes.ts), oldest first. */
    notes: async () => (await listCardNotes()).map(toAppNote),

    /** Writes a card's note; an empty body deletes it. */
    setNote: async (p) => {
      const body = typeof p.body === "string" ? p.body : "";
      const note = await setCardNote(str(p, "cardId"), body);
      return note == null ? null : toAppNote(note);
    },

    /** Recent sessions with the cards each lapsed and noted (core/recent-sessions.ts). */
    sessions: async (p) => recentSessions(optNum(p, "limit") ?? 5),

    searchCards: async (p) => {
      const query = typeof p.query === "string" ? p.query.trim() : "";
      if (query === "") return [];
      const found = await searchCards(query, { limit: optNum(p, "limit") ?? 20 });
      return found.map((c) => toAppCard(c, c.deck.name));
    },

    /** Recently reviewed card ids with their local day: the dashboard ranks wiki pages by it. */
    recentlyStudied: async (p) => recentlyStudied(optNum(p, "limit") ?? 100),
  };
}
