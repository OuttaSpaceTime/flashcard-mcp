import { describe, it, expect } from "vitest";
import { normalizeDates } from "../../src/db/normalize.js";
import { createDeck } from "../../src/core/deck-service.js";
import { getDb } from "../../src/db/client.js";

describe("normalizeDates", () => {
  it("rewrites epoch-ms integers as ISO text Prisma reads as the same instant", async () => {
    const db = getDb();
    const deck = await createDeck("Dates");
    const card = await db.card.create({ data: { deckId: deck.id, front: "Q", back: "A" } });
    const ms = Date.UTC(2026, 8, 29, 18, 42, 9, 303);
    await db.$executeRawUnsafe(
      `INSERT INTO "Review" (id, cardId, rating, stability, difficulty, elapsedDays, reviewedAt) VALUES ('r1', ?, 3, 1, 5, 0, ?)`,
      card.id,
      ms
    );
    expect(await normalizeDates(db)).toBe(1);
    const raw = await db.$queryRawUnsafe<{ t: string; v: string }[]>(
      `SELECT typeof(reviewedAt) AS t, substr(reviewedAt, 1) || '' AS v FROM "Review" WHERE id = 'r1'`
    );
    expect(raw[0]).toEqual({ t: "text", v: "2026-09-29T18:42:09.303+00:00" });
    const review = await db.review.findUnique({ where: { id: "r1" } });
    expect(review?.reviewedAt.getTime()).toBe(ms);
  });

  it("does nothing on a second run", async () => {
    expect(await normalizeDates(getDb())).toBe(0);
  });
});
