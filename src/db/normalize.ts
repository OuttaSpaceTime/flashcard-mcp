import type { PrismaClient } from "@prisma/client";

/**
 * Every DateTime column, as SQLite stores it.
 *
 * Older Prisma versions wrote DateTime as epoch-ms INTEGERs and current ones
 * write ISO TEXT, and a master.db that lived through both held a mix. SQLite
 * orders every INTEGER before every TEXT whatever instant each holds, so a
 * `where`/`orderBy` on a mixed column silently drops or misorders rows, and
 * every reader had to pull whole tables and compare in JS. Converting the
 * integers once, at start, makes the columns uniform, so queries can use SQL
 * windows and the indexes. Several machines share decks through AnkiWeb, each
 * with its own master.db, which is why it runs on every start rather than as
 * a one-off command someone has to remember on each machine.
 */
export const DATETIME_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["Deck", "createdAt"],
  ["Card", "due"],
  ["Card", "lastReview"],
  ["Card", "leechFlaggedAt"],
  ["Card", "createdAt"],
  ["Card", "updatedAt"],
  ["Review", "reviewedAt"],
  ["StudySession", "startTime"],
  ["StudySession", "endTime"],
  ["Topic", "createdAt"],
  ["LearningGoal", "createdAt"],
  ["DeletedCard", "deletedAt"],
];

/**
 * Rewrites epoch-ms INTEGER datetimes as the ISO text current Prisma writes
 * (`2026-09-29T18:42:09.303+00:00`). Idempotent: once nothing is an integer,
 * each statement matches no row. Returns how many values it converted.
 */
export async function normalizeDates(db: PrismaClient): Promise<number> {
  let converted = 0;
  for (const [table, column] of DATETIME_COLUMNS) {
    converted += await db.$executeRawUnsafe(
      `UPDATE "${table}" SET "${column}" = strftime('%Y-%m-%dT%H:%M:%f+00:00', "${column}" / 1000.0, 'unixepoch')
       WHERE typeof("${column}") = 'integer'`
    );
  }
  return converted;
}
