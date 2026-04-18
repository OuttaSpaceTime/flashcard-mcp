/**
 * Anki .apkg import/export with full scheduling data preservation.
 *
 * .apkg = ZIP containing SQLite DB (collection.anki21) + media files.
 * This module reads and writes the Anki database schema directly
 * using better-sqlite3, converting between SM-2 and FSRS scheduling.
 */

import Database from "better-sqlite3";
import { getDb } from "../db/client.js";
import AdmZip from "adm-zip";
import { decompress as zstdDecompress } from "fzstd";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { State } from "ts-fsrs";
import { serializeTags } from "./types.js";

// --- Types ---

export interface ApkgExportCard {
  id: string;
  front: string;
  back: string;
  tags: string[];
  stability: number;
  difficulty: number;
  state: number;
  reps: number;
  lapses: number;
  due: Date;
  interval: number;
  reviews: Array<{
    rating: number;
    reviewedAt: Date;
    responseMs: number;
    stability: number;
    difficulty: number;
  }>;
}

export interface ApkgExportDeck {
  deckName: string;
  cards: ApkgExportCard[];
}

export interface ApkgImportCard {
  front: string;
  back: string;
  tags: string[];
  stability: number;
  difficulty: number;
  state: number;
  reps: number;
  lapses: number;
  due: Date;
  interval: number;
  reviews: Array<{
    rating: number;
    reviewedAt: Date;
    responseMs: number;
  }>;
}

export interface ApkgImportDeck {
  name: string;
  cards: ApkgImportCard[];
}

export interface ApkgImportResult {
  decks: ApkgImportDeck[];
}

// --- SM-2 ↔ FSRS Conversion ---

const DEFAULT_CRT = Math.floor(new Date("2020-01-01").getTime() / 1000);

function ankiTypeToFsrsState(type: number): number {
  switch (type) {
    case 0: return State.New;
    case 1: return State.Learning;
    case 2: return State.Review;
    case 3: return State.Relearning;
    default: return State.New;
  }
}

function ankiDueToDate(due: number, type: number, crt: number): Date {
  if (type === 2) return new Date((crt + due * 86400) * 1000);
  if (type === 1 || type === 3) return new Date(due * 1000);
  return new Date();
}

export function convertSM2toFSRS(sm2: {
  ivl: number;
  factor: number;
  type: number;
  reps: number;
  lapses: number;
  due: number;
}): {
  stability: number;
  difficulty: number;
  state: number;
  reps: number;
  lapses: number;
  due: Date;
  interval: number;
} {
  const state = ankiTypeToFsrsState(sm2.type);

  // Stability ≈ interval (days of memory strength)
  // For learning/relearning cards with ivl=0, use a small positive stability
  // based on the fact that the card has been seen
  const stability = sm2.ivl > 0
    ? sm2.ivl
    : sm2.reps > 0
      ? Math.max(0.5, sm2.reps * 0.5) // seen but still learning
      : 0;

  // Difficulty: SM-2 ease factor is in permille (2500 = 2.5x)
  // FSRS difficulty is roughly 1-10
  // Higher ease = easier = lower difficulty
  // factor range: ~1300-5000, map to difficulty ~1-10
  let difficulty: number;
  if (sm2.factor === 0) {
    difficulty = 5; // default for new cards
  } else {
    difficulty = Math.max(1, Math.min(10, 11 - sm2.factor / 500));
  }

  // Due date conversion
  let due: Date;
  if (state === State.New) {
    due = new Date();
  } else if (state === State.Learning || state === State.Relearning) {
    // Learning cards: due is epoch seconds
    due = new Date(sm2.due * 1000);
  } else {
    // Review cards: due is days since collection creation
    // Approximate: convert to absolute date
    due = new Date(
      (DEFAULT_CRT + sm2.due * 86400) * 1000
    );
  }

  return {
    stability,
    difficulty,
    state,
    reps: sm2.reps,
    lapses: sm2.lapses,
    due,
    interval: sm2.ivl,
  };
}

export function convertFSRStoSM2(fsrs: {
  stability: number;
  difficulty: number;
  state: number;
  reps: number;
  lapses: number;
  due: Date;
  interval: number;
}): {
  ivl: number;
  factor: number;
  type: number;
  queue: number;
  reps: number;
  lapses: number;
  due: number;
} {
  // Map FSRS State to Anki type
  let type: number;
  let queue: number;
  switch (fsrs.state) {
    case State.New:
      type = 0;
      queue = 0;
      break;
    case State.Learning:
      type = 1;
      queue = 1;
      break;
    case State.Review:
      type = 2;
      queue = 2;
      break;
    case State.Relearning:
      type = 3;
      queue = 3;
      break;
    default:
      type = 0;
      queue = 0;
  }

  // Interval
  const ivl = Math.max(0, Math.round(fsrs.interval));

  // Ease factor: reverse of difficulty mapping
  // difficulty 1-10 → factor ~5000-500
  let factor: number;
  if (fsrs.state === State.New) {
    factor = 0;
  } else {
    factor = Math.max(1300, Math.min(5000, Math.round((11 - fsrs.difficulty) * 500)));
  }

  // Due
  let due: number;
  if (fsrs.state === State.New) {
    due = 0;
  } else if (fsrs.state === State.Learning || fsrs.state === State.Relearning) {
    due = Math.floor(fsrs.due.getTime() / 1000);
  } else {
    due = Math.floor(
      (fsrs.due.getTime() / 1000 - DEFAULT_CRT) / 86400
    );
  }

  return { ivl, factor, type, queue, reps: fsrs.reps, lapses: fsrs.lapses, due };
}

// --- Export ---

function fieldChecksum(text: string): number {
  // Simple checksum of first field (Anki uses CRC32-like)
  let hash = 0;
  const str = text.replace(/<[^>]+>/g, "").trim(); // strip HTML
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash);
}

const FIELD_SEP = String.fromCharCode(0x1f);

const BASIC_MODEL_ID = 1609140000000;

function getBasicModel(): Record<string, unknown> {
  return {
    [BASIC_MODEL_ID]: {
      id: BASIC_MODEL_ID,
      name: "Basic",
      type: 0,
      mod: Math.floor(Date.now() / 1000),
      usn: -1,
      sortf: 0,
      did: null,
      latexPre:
        "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
      latexPost: "\\end{document}",
      css: ".card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n",
      flds: [
        {
          name: "Front",
          ord: 0,
          sticky: false,
          rtl: false,
          font: "Arial",
          size: 20,
          media: [],
        },
        {
          name: "Back",
          ord: 1,
          sticky: false,
          rtl: false,
          font: "Arial",
          size: 20,
          media: [],
        },
      ],
      tmpls: [
        {
          name: "Card 1",
          ord: 0,
          qfmt: "{{Front}}",
          afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}',
          did: null,
          bqfmt: "",
          bafmt: "",
        },
      ],
      tags: [],
      req: [[0, "all", [0]]],
    },
  };
}

export async function exportToApkg(
  outPath: string,
  decks: ApkgExportDeck[]
): Promise<void> {
  const db = new Database(":memory:");

  // Create schema
  db.exec(`
    CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL, scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL);
    CREATE TABLE notes (id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL, sfld text NOT NULL, csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
    CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL, ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL, odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
    CREATE TABLE revlog (id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL, ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL, factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL);
    CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL);
    CREATE INDEX ix_cards_nid ON cards (nid);
    CREATE INDEX ix_cards_sched ON cards (did, queue, due);
    CREATE INDEX ix_notes_usn ON notes (usn);
    CREATE INDEX ix_revlog_cid ON revlog (cid);
  `);

  // Build deck map
  const deckMap: Record<string, unknown> = {
    "1": {
      id: 1,
      name: "Default",
      conf: 1,
      usn: -1,
      mod: Math.floor(Date.now() / 1000),
      collapsed: false,
      browserCollapsed: false,
      extendNew: 10,
      extendRev: 50,
      dyn: 0,
      newToday: [0, 0],
      revToday: [0, 0],
      lrnToday: [0, 0],
      timeToday: [0, 0],
      desc: "",
    },
  };

  decks.forEach((deck, i) => {
    const deckId = 1000000000000 + i;
    deckMap[deckId] = {
      id: deckId,
      name: deck.deckName,
      conf: 1,
      usn: -1,
      mod: Math.floor(Date.now() / 1000),
      collapsed: false,
      browserCollapsed: false,
      extendNew: 10,
      extendRev: 50,
      dyn: 0,
      newToday: [0, 0],
      revToday: [0, 0],
      lrnToday: [0, 0],
      timeToday: [0, 0],
      desc: "",
    };
  });

  const now = Math.floor(Date.now() / 1000);
  const crt = DEFAULT_CRT;

  // Insert collection
  db.prepare(
    `INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, -1, 0, ?, ?, ?, ?, ?)`
  ).run(
    crt,
    Date.now(),
    Date.now(),
    JSON.stringify({}),
    JSON.stringify(getBasicModel()),
    JSON.stringify(deckMap),
    JSON.stringify({
      "1": {
        id: 1,
        name: "Default",
        replayq: true,
        lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
        rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500 },
        new: { delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, perDay: 20, order: 1, separate: true },
        maxTaken: 60,
        timer: 0,
        autoplay: true,
        mod: 0,
        usn: 0,
      },
    }),
    JSON.stringify({})
  );

  const insertNote = db.prepare(
    `INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')`
  );
  const insertCard = db.prepare(
    `INSERT INTO cards VALUES (?, ?, ?, 0, ?, -1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, '')`
  );
  const insertRevlog = db.prepare(
    `INSERT INTO revlog VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?)`
  );

  let cardCounter = 0;
  for (let di = 0; di < decks.length; di++) {
    const deck = decks[di];
    const ankiDeckId = 1000000000000 + di;

    for (const card of deck.cards) {
      cardCounter++;
      const noteId = Date.now() * 1000 + cardCounter;
      const cardId = noteId + 1;
      const guid = card.id.slice(0, 10) + cardCounter;

      const tagsStr = card.tags.length > 0 ? ` ${card.tags.join(" ")} ` : "";
      const flds = card.front + FIELD_SEP + card.back;

      // Convert FSRS → SM-2
      const sm2 = convertFSRStoSM2({
        stability: card.stability,
        difficulty: card.difficulty,
        state: card.state,
        reps: card.reps,
        lapses: card.lapses,
        due: card.due,
        interval: card.interval,
      });

      insertNote.run(
        noteId,
        guid,
        BASIC_MODEL_ID,
        now,
        tagsStr,
        flds,
        card.front.replace(/<[^>]+>/g, ""),
        fieldChecksum(card.front)
      );

      insertCard.run(
        cardId,
        noteId,
        ankiDeckId,
        now,
        sm2.type,
        sm2.queue,
        sm2.due,
        sm2.ivl,
        sm2.factor,
        sm2.reps,
        sm2.lapses
      );

      // Insert review history
      for (const review of card.reviews) {
        const revId = Math.floor(review.reviewedAt.getTime());
        const sm2AfterReview = convertFSRStoSM2({
          stability: review.stability,
          difficulty: review.difficulty,
          state: card.state,
          reps: card.reps,
          lapses: card.lapses,
          due: card.due,
          interval: card.interval,
        });

        insertRevlog.run(
          revId,
          cardId,
          review.rating,
          sm2AfterReview.ivl,
          0, // lastIvl (approximate)
          sm2AfterReview.factor,
          Math.min(review.responseMs, 60000),
          sm2AfterReview.type
        );
      }
    }
  }

  // Write to ZIP
  const dbBuffer = db.serialize();
  db.close();

  const zip = new AdmZip();
  zip.addFile("collection.anki21", Buffer.from(dbBuffer));
  zip.addFile("media", Buffer.from("{}"));
  zip.writeZip(outPath);
}

// --- Import ---

/**
 * Extract the SQLite database from an .apkg ZIP.
 * Handles three formats:
 *  - collection.anki21b (zstd-compressed SQLite, modern Anki 2.1.50+)
 *  - collection.anki21 (plain SQLite, Anki 2.1.x)
 *  - collection.anki2 (plain SQLite, legacy Anki 2.0)
 */
function extractDatabase(zip: AdmZip): Buffer {
  const entries = zip.getEntries();

  // Prefer anki21b (zstd-compressed, has the real data in modern exports)
  const anki21b = entries.find((e) => e.entryName === "collection.anki21b");
  if (anki21b) {
    const compressed = anki21b.getData();
    return Buffer.from(zstdDecompress(compressed));
  }

  // Fall back to anki21
  const anki21 = entries.find((e) => e.entryName === "collection.anki21");
  if (anki21) return anki21.getData();

  // Fall back to anki2
  const anki2 = entries.find((e) => e.entryName === "collection.anki2");
  if (anki2) return anki2.getData();

  throw new Error(
    "No collection database found in .apkg file (expected collection.anki21b, collection.anki21, or collection.anki2)"
  );
}

/**
 * Read deck ID → name mapping. Handles both:
 *  - Schema v18+: separate `decks` table with id/name columns
 *  - Schema v11: JSON in `col.decks` column
 */
function readDecks(
  db: InstanceType<typeof Database>
): Map<number, string> {
  const deckMap = new Map<number, string>();

  // Try v18 `decks` table first
  const hasDecksTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decks'")
    .get();

  if (hasDecksTable) {
    const rows = db
      .prepare("SELECT id, name FROM decks")
      .all() as Array<{ id: number; name: string }>;
    for (const row of rows) {
      deckMap.set(row.id, row.name);
    }
    return deckMap;
  }

  // Fall back to v11 JSON in col.decks
  const col = db.prepare("SELECT decks FROM col").get() as
    | { decks: string }
    | undefined;
  if (col?.decks && typeof col.decks === "string") {
    const decksJson = JSON.parse(col.decks) as Record<
      string,
      { id: number; name: string }
    >;
    for (const info of Object.values(decksJson)) {
      deckMap.set(info.id, info.name);
    }
  }

  return deckMap;
}

/**
 * Read collection creation time from `col` table.
 */
function readCrt(db: InstanceType<typeof Database>): number {
  try {
    const col = db.prepare("SELECT crt FROM col").get() as
      | { crt: number }
      | undefined;
    return col?.crt ?? DEFAULT_CRT;
  } catch {
    return DEFAULT_CRT;
  }
}

/**
 * Try to read native FSRS parameters from card.data JSON.
 * Modern Anki with FSRS enabled stores: {"s": stability, "d": difficulty, "dr": desired_retention}
 */
function parseFsrsFromCardData(data: string): {
  stability?: number;
  difficulty?: number;
} | null {
  if (data === "" || data === "{}") return null;
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed.s === "number" && typeof parsed.d === "number") {
      return { stability: parsed.s, difficulty: parsed.d };
    }
  } catch {
    // not JSON or no FSRS data
  }
  return null;
}

export async function importFromApkg(
  filePath: string
): Promise<ApkgImportResult> {
  const zip = new AdmZip(filePath);
  const dbBuffer = extractDatabase(zip);

  const tmpDir = mkdtempSync(join(tmpdir(), "apkg-import-"));
  const dbPath = join(tmpDir, "collection.db");
  writeFileSync(dbPath, dbBuffer);

  try {
    const db = new Database(dbPath, { readonly: true });

    const deckMap = readDecks(db);
    const crt = readCrt(db);

    // Read notes
    const notes = db.prepare("SELECT id, guid, mid, tags, flds FROM notes").all() as Array<{
      id: number;
      guid: string;
      mid: number;
      tags: string;
      flds: string;
    }>;
    const noteMap = new Map(notes.map((n) => [n.id, n]));

    // Read cards
    const cards = db.prepare(
      "SELECT id, nid, did, type, queue, due, ivl, factor, reps, lapses, data FROM cards"
    ).all() as Array<{
      id: number;
      nid: number;
      did: number;
      type: number;
      queue: number;
      due: number;
      ivl: number;
      factor: number;
      reps: number;
      lapses: number;
      data: string;
    }>;

    // Read review log
    const revlog = db
      .prepare("SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog ORDER BY id")
      .all() as Array<{
      id: number;
      cid: number;
      ease: number;
      ivl: number;
      lastIvl: number;
      factor: number;
      time: number;
      type: number;
    }>;

    // Group reviews by card ID
    const reviewsByCard = new Map<number, typeof revlog>();
    for (const rev of revlog) {
      const list = reviewsByCard.get(rev.cid) ?? [];
      list.push(rev);
      reviewsByCard.set(rev.cid, list);
    }

    // Group cards by deck
    const cardsByDeck = new Map<number, typeof cards>();
    for (const card of cards) {
      const list = cardsByDeck.get(card.did) ?? [];
      list.push(card);
      cardsByDeck.set(card.did, list);
    }

    // Build result
    const result: ApkgImportResult = { decks: [] };

    for (const [deckId, deckName] of deckMap) {
      const deckCards = cardsByDeck.get(deckId) ?? [];
      if (deckCards.length === 0) continue;

      const importDeck: ApkgImportDeck = { name: deckName, cards: [] };

      for (const card of deckCards) {
        const note = noteMap.get(card.nid);
        if (!note) continue;

        const fields = note.flds.split(FIELD_SEP);
        const front = fields[0] ?? "";
        const back = fields[1] ?? "";
        const tags = note.tags.trim().split(/\s+/).filter(Boolean);

        // Check if card has native FSRS data (Anki with FSRS enabled)
        const nativeFsrs = parseFsrsFromCardData(card.data);

        let stability: number;
        let difficulty: number;
        let state: number;
        let due: Date;
        let interval: number;

        if (nativeFsrs?.stability != null) {
          // Use native FSRS parameters directly
          stability = nativeFsrs.stability;
          difficulty = nativeFsrs.difficulty ?? 5;
          state = ankiTypeToFsrsState(card.type);
          interval = card.ivl;
          due = ankiDueToDate(card.due, card.type, crt);
        } else {
          // Convert SM-2 → FSRS
          const fsrs = convertSM2toFSRS({
            ivl: card.ivl,
            factor: card.factor,
            type: card.type,
            reps: card.reps,
            lapses: card.lapses,
            due: card.due,
          });
          stability = fsrs.stability;
          difficulty = fsrs.difficulty;
          state = fsrs.state;
          interval = fsrs.interval;
          due = ankiDueToDate(card.due, card.type, crt);
        }

        const cardReviews = (reviewsByCard.get(card.id) ?? []).map((r) => ({
          rating: r.ease,
          reviewedAt: new Date(r.id),
          responseMs: r.time,
        }));

        importDeck.cards.push({
          front,
          back,
          tags,
          stability,
          difficulty,
          state,
          reps: card.reps,
          lapses: card.lapses,
          due,
          interval,
          reviews: cardReviews,
        });
      }

      result.decks.push(importDeck);
    }

    db.close();
    return result;
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  }
}

function lastReviewDate(reviews: ApkgImportCard["reviews"], fallback?: Date | null): Date | null {
  return reviews.length > 0 ? reviews[reviews.length - 1].reviewedAt : (fallback ?? null);
}

function apkgCardData(card: ApkgImportCard, lastReview: Date | null) {
  return {
    back: card.back,
    tags: serializeTags(card.tags),
    stability: card.stability,
    difficulty: card.difficulty,
    state: card.state,
    reps: card.reps,
    lapses: card.lapses,
    due: card.due,
    interval: card.interval,
    lastReview,
  };
}

/** Import a list of parsed apkg cards into the database for a single deck. */
export async function importApkgCards(
  cards: ApkgImportCard[],
  deckId: string,
  opts: { conflict?: "ours" | "theirs"; dryRun?: boolean }
): Promise<{ created: number; updated: number; skipped: number }> {
  const { conflict = "ours", dryRun = false } = opts;
  const db = getDb();

  const validCards = cards.filter((c) => c.front.trim() !== "");
  const fronts = validCards.map((c) => c.front);

  const existingRows = await db.card.findMany({
    where: { deckId, front: { in: fronts } },
    select: { id: true, front: true, lastReview: true },
  });
  const existingByFront = new Map(existingRows.map((r) => [r.front, r]));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const card of validCards) {
    const existing = existingByFront.get(card.front);

    if (existing) {
      if (conflict === "theirs") {
        updated++;
        if (!dryRun) {
          await db.card.update({
            where: { id: existing.id },
            data: apkgCardData(card, lastReviewDate(card.reviews, existing.lastReview)),
          });
        }
      } else {
        skipped++;
      }
      continue;
    }

    created++;
    if (!dryRun) {
      const newCard = await db.card.create({
        data: { deckId, front: card.front, ...apkgCardData(card, lastReviewDate(card.reviews)) },
      });

      for (const review of card.reviews) {
        await db.review.create({
          data: {
            cardId: newCard.id,
            rating: review.rating,
            responseMs: review.responseMs,
            stability: card.stability,
            difficulty: card.difficulty,
            elapsedDays: 0,
            reviewedAt: review.reviewedAt,
          },
        });
      }
    }
  }

  return { created, updated, skipped };
}
