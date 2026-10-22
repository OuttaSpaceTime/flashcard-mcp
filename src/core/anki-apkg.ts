/**
 * Anki .apkg import/export with full scheduling data preservation.
 *
 * .apkg = ZIP containing SQLite DB (collection.anki21) + media files.
 * This module reads and writes the Anki database schema directly
 * using better-sqlite3, converting between SM-2 and FSRS scheduling.
 */

import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import { decompress as zstdDecompress } from "fzstd";
import { State } from "ts-fsrs";
import { getDb } from "../db/client.js";
import {
  importCards,
  type ImportDeck,
  type ImportedReview,
  type ImportItem,
  type ImportOptions,
  type ImportResult,
} from "./card-import.js";
import type { CarriedSchedule } from "./card-service.js";
import { parseTags } from "./types.js";

// --- Types ---

export interface ApkgExportCard {
  id: string;
  front: string;
  back: string;
  tags: string[];
  schedule: CarriedSchedule;
  /** Oldest first, each with the memory state it left the card in. */
  reviews: Array<ImportedReview & { stability: number; difficulty: number }>;
}

export interface ApkgExportDeck {
  deckName: string;
  cards: ApkgExportCard[];
}

export interface ApkgImportCard extends ImportItem {
  tags: string[];
  schedule: CarriedSchedule;
  reviews: ImportedReview[];
}

export interface ApkgImportDeck extends ImportDeck {
  items: ApkgImportCard[];
}

/** An Anki package by its extension: a deck package (.apkg) or a collection package (.colpkg). */
export function isApkgPath(path: string): boolean {
  return /\.(apkg|colpkg)$/i.test(path);
}

// --- SM-2 ↔ FSRS Conversion ---

const DEFAULT_CRT = Math.floor(new Date("2020-01-01").getTime() / 1000);
const DAY_SECONDS = 86400;

/**
 * Anki's card types (0 new, 1 learning, 2 review, 3 relearning) are ts-fsrs's
 * State numbers, so a type converts as itself; anything else reads as New.
 */
function ankiTypeToFsrsState(type: number): State {
  return type === State.Learning || type === State.Review || type === State.Relearning ? type : State.New;
}

/**
 * When an Anki card is due. Review cards and interday (re)learning cards
 * store a day number counted from the collection's creation (`crt`);
 * intraday (re)learning cards store epoch seconds. The queue says which, but a
 * suspended or buried card has lost its queue, so the magnitude decides: a day
 * number is never anywhere near 1e9.
 */
function ankiDueToDate(due: number, type: number, crt: number): Date {
  if (type === 0) return new Date();
  const epochSeconds = (type === 1 || type === 3) && due > 1_000_000_000;
  return new Date((epochSeconds ? due : crt + due * DAY_SECONDS) * 1000);
}

/** SM-2's ease factor (permille, 1300-5000) for an FSRS difficulty (1-10). */
function ankiFactor(difficulty: number): number {
  return Math.max(1300, Math.min(5000, Math.round((11 - difficulty) * 500)));
}

/** FSRS memory state from SM-2's interval and ease, for cards without native FSRS data. */
export function convertSM2toFSRS(sm2: { ivl: number; factor: number; reps: number }): {
  stability: number;
  difficulty: number;
} {
  // Stability ≈ interval (days of memory strength)
  // For learning/relearning cards with ivl=0, use a small positive stability
  // based on the fact that the card has been seen
  const stability = sm2.ivl > 0
    ? sm2.ivl
    : sm2.reps > 0
      ? Math.max(0.5, sm2.reps * 0.5) // seen but still learning
      : 0;

  // Difficulty: higher ease = easier = lower difficulty; 0 is a new card.
  const difficulty = sm2.factor === 0 ? 5 : Math.max(1, Math.min(10, 11 - sm2.factor / 500));

  return { stability, difficulty };
}

/** Anki's scheduling columns for a card's FSRS schedule. */
export function convertFSRStoSM2(fsrs: {
  difficulty: number;
  state: number;
  due: Date;
  interval: number;
  suspended: boolean;
}): {
  ivl: number;
  factor: number;
  type: number;
  queue: number;
  due: number;
} {
  const type = ankiTypeToFsrsState(fsrs.state);
  const learning = type === State.Learning || type === State.Relearning;
  // Learning cards are written as intraday (queue 1, due in epoch seconds),
  // whatever their step; -1 is Anki's suspended queue.
  const queue = fsrs.suspended ? -1 : learning ? 1 : type;

  let due: number;
  if (type === State.New) {
    due = 0;
  } else if (learning) {
    due = Math.floor(fsrs.due.getTime() / 1000);
  } else {
    due = Math.floor((fsrs.due.getTime() / 1000 - DEFAULT_CRT) / DAY_SECONDS);
  }

  return {
    ivl: Math.max(0, Math.round(fsrs.interval)),
    factor: type === State.New ? 0 : ankiFactor(fsrs.difficulty),
    type,
    queue,
    due,
  };
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

function ankiDeckJson(id: number, name: string, mod: number): Record<string, unknown> {
  return {
    id,
    name,
    conf: 1,
    usn: -1,
    mod,
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
}

/**
 * Anki's revlog type for the review at `index` of a card's history: 0 learn,
 * 1 review, 2 relearn. Reviews here keep no state, so this is approximate: the
 * first review is learning, one after an Again is relearning.
 */
function revlogType(reviews: ApkgExportCard["reviews"], index: number): number {
  if (index === 0) return 0;
  return reviews[index - 1].rating === 1 ? 2 : 1;
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

  const now = Math.floor(Date.now() / 1000);

  // Build deck map
  const deckMap: Record<string, unknown> = { "1": ankiDeckJson(1, "Default", now) };
  decks.forEach((deck, i) => {
    const deckId = 1000000000000 + i;
    deckMap[deckId] = ankiDeckJson(deckId, deck.deckName, now);
  });

  // Insert collection
  db.prepare(
    `INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, -1, 0, ?, ?, ?, ?, ?)`
  ).run(
    DEFAULT_CRT,
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

  // The revlog id is its primary key and its timestamp in ms: two reviews in
  // the same millisecond move the later one up by one.
  const revIds = new Set<number>();

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
      const sm2 = convertFSRStoSM2(card.schedule);

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
        card.schedule.reps,
        card.schedule.lapses
      );

      // Each review's interval is the stability it left (FSRS's interval at
      // 90% retention), its factor the difficulty.
      let lastIvl = 0;
      card.reviews.forEach((review, i) => {
        let revId = review.reviewedAt.getTime();
        while (revIds.has(revId)) revId++;
        revIds.add(revId);

        const ivl = Math.max(0, Math.round(review.stability));
        insertRevlog.run(
          revId,
          cardId,
          review.rating,
          ivl,
          lastIvl,
          ankiFactor(review.difficulty),
          Math.min(review.responseMs, 60000),
          revlogType(card.reviews, i)
        );
        lastIvl = ivl;
      });
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

/** Write the cards of one deck (or all) with their schedules and history to an .apkg. */
export async function exportCardsToApkg(
  outPath: string,
  deckId?: string
): Promise<{ cardCount: number; deckCount: number }> {
  const decks = await getDb().deck.findMany({
    where: deckId != null ? { id: deckId } : {},
    orderBy: { name: "asc" },
    include: {
      cards: {
        orderBy: { createdAt: "asc" },
        include: { reviews: { orderBy: { reviewedAt: "asc" } } },
      },
    },
  });

  const exportDecks: ApkgExportDeck[] = decks
    .filter((deck) => deck.cards.length > 0)
    .map((deck) => ({
      deckName: deck.name,
      cards: deck.cards.map((c) => ({
        id: c.id,
        front: c.front,
        back: c.back,
        tags: parseTags(c.tags),
        schedule: c,
        reviews: c.reviews.map((r) => ({
          rating: r.rating,
          reviewedAt: r.reviewedAt,
          responseMs: r.responseMs ?? 0,
          stability: r.stability,
          difficulty: r.difficulty,
        })),
      })),
    }));

  await exportToApkg(outPath, exportDecks);
  return {
    cardCount: exportDecks.reduce((n, d) => n + d.cards.length, 0),
    deckCount: exportDecks.length,
  };
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

  if (hasDecksTable != null) {
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
  if (col != null && typeof col.decks === "string" && col.decks !== "") {
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
 * Native FSRS memory state from card.data JSON, when Anki ran FSRS on it.
 * Modern Anki stores: {"s": stability, "d": difficulty, "dr": desired_retention}
 */
function parseFsrsFromCardData(data: string): { stability: number; difficulty: number } | null {
  if (data === "" || data === "{}") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { s, d } = parsed as { s?: unknown; d?: unknown };
  return typeof s === "number" && typeof d === "number" ? { stability: s, difficulty: d } : null;
}

interface AnkiCardRow {
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
}

/** Read an .apkg's decks and cards, schedules converted to FSRS. Writes nothing. */
export function readApkg(filePath: string): ApkgImportDeck[] {
  const db = new Database(extractDatabase(new AdmZip(filePath)), { readonly: true });
  try {
    const deckMap = readDecks(db);
    const crt = readCrt(db);

    const notes = db.prepare("SELECT id, tags, flds FROM notes").all() as Array<{
      id: number;
      tags: string;
      flds: string;
    }>;
    const noteMap = new Map(notes.map((n) => [n.id, n]));

    const cards = db.prepare(
      "SELECT id, nid, did, type, queue, due, ivl, factor, reps, lapses, data FROM cards"
    ).all() as AnkiCardRow[];

    // Ease 0 rows are manual reschedules, not answers.
    const revlog = db
      .prepare("SELECT cid, ease, time, id FROM revlog WHERE ease BETWEEN 1 AND 4 ORDER BY id")
      .all() as Array<{ id: number; cid: number; ease: number; time: number }>;

    const reviewsByCard = new Map<number, ImportedReview[]>();
    for (const rev of revlog) {
      const list = reviewsByCard.get(rev.cid) ?? [];
      list.push({ rating: rev.ease, reviewedAt: new Date(rev.id), responseMs: rev.time });
      reviewsByCard.set(rev.cid, list);
    }

    const cardsByDeck = new Map<number, AnkiCardRow[]>();
    for (const card of cards) {
      const list = cardsByDeck.get(card.did) ?? [];
      list.push(card);
      cardsByDeck.set(card.did, list);
    }

    const decks: ApkgImportDeck[] = [];
    for (const [deckId, deckName] of deckMap) {
      const items: ApkgImportCard[] = [];
      for (const card of cardsByDeck.get(deckId) ?? []) {
        const note = noteMap.get(card.nid);
        if (!note) continue;

        const fields = note.flds.split(FIELD_SEP);
        const reviews = reviewsByCard.get(card.id) ?? [];
        // Native FSRS memory state when Anki ran FSRS, else converted from SM-2.
        const memory = parseFsrsFromCardData(card.data) ?? convertSM2toFSRS(card);

        items.push({
          front: fields[0] ?? "",
          back: fields[1] ?? "",
          tags: note.tags.trim().split(/\s+/).filter(Boolean),
          schedule: {
            ...memory,
            state: ankiTypeToFsrsState(card.type),
            reps: card.reps,
            lapses: card.lapses,
            due: ankiDueToDate(card.due, card.type, crt),
            interval: card.ivl,
            lastReview: reviews.length > 0 ? reviews[reviews.length - 1].reviewedAt : null,
            suspended: card.queue === -1,
          },
          reviews,
        });
      }
      if (items.length > 0) decks.push({ name: deckName, items });
    }
    return decks;
  } finally {
    db.close();
  }
}

/** Import an .apkg's cards into decks of the same names, with their schedules and history. */
export async function importApkgFile(filePath: string, opts: ImportOptions = {}): Promise<ImportResult> {
  return importCards(readApkg(filePath), opts);
}
