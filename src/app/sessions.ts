import { getDb } from "../db/client.js";

/**
 * The app's Home lists recent study sessions with what each exposed: the cards
 * that lapsed (rated Again) and the cards noted during it (card-notes.ts), so
 * a fix session can be started from there.
 *
 * Reviews carry no session id, so a session's reviews are the ones in its
 * window: from its start to its end, or, for one never closed (endTime stays
 * null until end_session), to the next session's start. One session is driven
 * at a time, so the windows do not overlap. Sessions that reviewed nothing are
 * left out: they carry nothing to show.
 */

export interface SessionFlaws {
  id: string;
  startTime: string;
  endTime: string | null;
  cardsReviewed: number;
  accuracy: number;
  /** Each lapsed card once, in the order it first lapsed. Cards since deleted are gone with their reviews. */
  lapses: { cardId: string; front: string }[];
  /** Cards whose open note was written during the session. */
  noted: string[];
}

export async function recentSessions(limit = 5): Promise<SessionFlaws[]> {
  const db = getDb();
  const sessions = await db.studySession.findMany({
    where: { cardsReviewed: { gt: 0 } },
    orderBy: { startTime: "desc" },
    take: limit,
  });
  if (sessions.length === 0) return [];

  const ends = sessions.map((s, i) => s.endTime ?? (i > 0 ? sessions[i - 1].startTime : new Date()));
  const from = sessions[sessions.length - 1].startTime;
  const to = new Date(Math.max(...ends.map((d) => d.getTime())));

  const [lapses, notes] = await Promise.all([
    db.review.findMany({
      where: { rating: 1, reviewedAt: { gte: from, lte: to } },
      select: { cardId: true, reviewedAt: true, card: { select: { front: true } } },
      orderBy: { reviewedAt: "asc" },
    }),
    notesIn(from, to),
  ]);

  return sessions.map((s, i) => {
    const inside = (d: Date) => d >= s.startTime && d <= ends[i];
    const seen = new Set<string>();
    const lapsed: SessionFlaws["lapses"] = [];
    for (const r of lapses) {
      if (!inside(r.reviewedAt) || seen.has(r.cardId)) continue;
      seen.add(r.cardId);
      lapsed.push({ cardId: r.cardId, front: r.card.front });
    }
    return {
      id: s.id,
      startTime: s.startTime.toISOString(),
      endTime: s.endTime?.toISOString() ?? null,
      cardsReviewed: s.cardsReviewed,
      accuracy: s.accuracy,
      lapses: lapsed,
      noted: notes.filter((n) => inside(n.createdAt)).map((n) => n.cardId),
    };
  });
}

/** Notes written in a time window. */
async function notesIn(from: Date, to: Date): Promise<{ cardId: string; createdAt: Date }[]> {
  return getDb().cardNote.findMany({
    where: { createdAt: { gte: from, lte: to } },
    select: { cardId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}
