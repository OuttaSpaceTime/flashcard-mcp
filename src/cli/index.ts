#!/usr/bin/env node

import { Command, Option } from "commander";
import { createInterface } from "readline";
import { readFileSync, writeFileSync } from "fs";
import { createClient, databaseFile, setDb } from "../db/client.js";
import { prepareDatabase } from "../db/prepare.js";
import { listDeckStats, getDeckByName, getOrCreateDeck } from "../core/deck-service.js";
import { CARD_STATE_NAMES } from "../core/types.js";
import {
  createCard,
  searchCards,
  backfillEmbeddings,
  updateCard,
  listCards,
  embeddingCoverage,
  listCategories,
  setDeckCategory,
} from "../core/card-service.js";
import { initEmbeddings } from "../core/embeddings.js";
import { cardMaturity, isGrade } from "../core/scheduler.js";
import type { Grade } from "ts-fsrs";
import {
  startSession,
  getNextCardOrBlock,
  getQueuePosition,
  submitReview,
  endSession,
} from "../core/session-service.js";
import { leechBlockError } from "../core/leeches.js";
import { getFullStats, getMaturityReport } from "../core/analytics-service.js";
import { parseAnkiTxt, importTxtNotes, exportCardsToAnkiTxt } from "../core/anki-io.js";
import { exportCardsToApkg, importApkgFile, isApkgPath } from "../core/anki-apkg.js";
import type { ImportResult } from "../core/card-import.js";
import { dumpDatabase, restoreDatabase } from "../core/db-dump.js";
import { checkCalibration } from "../core/calibration.js";
import { getOverview } from "../core/overview.js";
import { localDay } from "../core/days.js";
import { PACKAGE_VERSION } from "../core/version.js";

const prisma = createClient();
setDb(prisma);

const program = new Command();

program
  .name("master")
  .description("Self-improving spaced repetition learning system")
  .version(PACKAGE_VERSION);

// Errors thrown from an action are printed by the run at the bottom, which
// exits non-zero; actions never call process.exit, so the client disconnects.

async function requireDeck(name: string) {
  const deck = await getDeckByName(name);
  if (deck == null) {
    throw new Error(`Deck "${name}" not found. Run \`master decks\` to see available decks.`);
  }
  return deck;
}

/** An integer option of at least `min`, or a clean error naming the flag. */
function intOption(value: string, flag: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${flag} must be a whole number of at least ${min}, got "${value}"`);
  }
  return n;
}

// --- init ---
program
  .command("init")
  .description("Create the default decks (the database itself is made by every start)")
  .action(async () => {
    const defaultDecks = [
      { name: "React", description: "React fundamentals and patterns" },
      { name: "TypeScript", description: "TypeScript type system and patterns" },
      { name: "Ruby on Rails", description: "Rails conventions and patterns" },
      { name: "Angular", description: "Angular framework" },
      { name: "Python", description: "Python language and ecosystem" },
      { name: "AI Systems", description: "AI integration, LLMs, and internals" },
      { name: "Crypto", description: "Cryptocurrency and blockchain" },
    ];

    for (const deck of defaultDecks) {
      await getOrCreateDeck(deck.name, deck.description);
      console.log(`  Deck: ${deck.name}`);
    }

    console.log("\nInitialization complete.");
  });

// --- decks ---
program
  .command("decks")
  .description("List all decks with stats")
  .action(async () => {
    const decks = await listDeckStats();
    if (decks.length === 0) {
      console.log("No decks. Run `master init` to create default decks.");
      return;
    }

    console.log("\nDecks:\n");
    for (const stats of decks) {
      console.log(`  ${stats.name} (${stats.totalCards} cards)`);
      console.log(
        `    Due: ${stats.dueCards} | New: ${stats.newCards} | Learning: ${stats.learningCards} | Review: ${stats.reviewCards} | Relearning: ${stats.relearningCards}`
      );
      console.log(
        `    Due breakdown: ${stats.dueNew} new | ${stats.dueLearning} learning | ${stats.dueReview} review | ${stats.dueRelearning} relearning`
      );
    }
    console.log();
  });

// --- cards ---
const cardsCmd = program.command("cards").description("Card management");

cardsCmd
  .command("add <deck>")
  .description("Add a card to a deck")
  .requiredOption("-f, --front <text>", "Card front (question)")
  .requiredOption("-b, --back <text>", "Card back (answer)")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .addOption(new Option("--type <type>", "Card type").choices(["guided", "unguided"]).default("guided"))
  .option("-c, --category <name>", "Card category")
  .action(
    async (
      deckName: string,
      opts: { front: string; back: string; tags?: string; type: "guided" | "unguided"; category?: string }
    ) => {
      const deck = await requireDeck(deckName);

      const { card, duplicateWarning } = await createCard({
        deckId: deck.id,
        front: opts.front,
        back: opts.back,
        tags: opts.tags?.split(",").map((t) => t.trim()),
        type: opts.type,
        category: opts.category,
        checkDuplicates: true,
      });

      if (duplicateWarning?.isDuplicate === true) {
        console.log(`\n  Warning: ${duplicateWarning.reason}`);
      }
      const front = card.front.length > 50 ? `${card.front.slice(0, 50)}...` : card.front;
      console.log(`  Card added to ${deckName}: "${front}"`);
    }
  );

cardsCmd
  .command("list")
  .description("List cards, soonest due first")
  .option("-d, --deck <deck>", "Filter by deck name")
  .option("-c, --category <name>", "Filter by category")
  .option("--uncategorized", "Show only cards with no category")
  .option("--due", "Show only cards due now (not suspended)")
  .addOption(new Option("--state <name>", "Filter by FSRS state").choices(CARD_STATE_NAMES))
  .option("--limit <n>", "Max rows to return (default 50, max 200)", "50")
  .action(
    async (opts: {
      deck?: string;
      category?: string;
      uncategorized?: boolean;
      due?: boolean;
      state?: string;
      limit: string;
    }) => {
      const deck = opts.deck != null ? await requireDeck(opts.deck) : undefined;
      const cards = await listCards({
        deckId: deck?.id,
        category: opts.uncategorized === true ? "__uncategorized__" : opts.category,
        state: opts.state,
        due: opts.due === true,
        orderBy: "due",
        limit: intOption(opts.limit, "--limit", 1),
      });

      if (cards.length === 0) {
        console.log("No cards found.");
        return;
      }

      console.log(`\n${cards.length} cards:\n`);
      for (const card of cards) {
        const state = CARD_STATE_NAMES[card.state] ?? "?";
        const cat = card.category != null ? ` {${card.category}}` : "";
        console.log(`  [${state}] ${card.front.slice(0, 60)} (${card.deck.name})${cat} - ${cardMaturity(card)}`);
      }
      console.log();
    }
  );

cardsCmd
  .command("search <query>")
  .description("Search cards by text")
  .action(async (query: string) => {
    const results = await searchCards(query);
    if (results.length === 0) {
      console.log("No cards found.");
      return;
    }

    console.log(`\n${results.length} results:\n`);
    for (const card of results) {
      console.log(`  ${card.front.slice(0, 60)}`);
      console.log(`    ${card.back.slice(0, 80)}`);
      console.log();
    }
  });

// --- categories ---
const categoriesCmd = program
  .command("categories")
  .description("Manage card categories");

categoriesCmd
  .command("list")
  .description("List all categories in use, with card counts")
  .action(async () => {
    const rows = await listCategories();
    if (rows.length === 0) {
      console.log("No cards yet.");
      return;
    }

    console.log("\nCategories:\n");
    for (const row of rows) {
      console.log(`  ${row.category ?? "(uncategorized)"}: ${row.cards} card(s)`);
    }
    console.log();
  });

categoriesCmd
  .command("add <name>")
  .description("Apply a category to cards (by deck or card id)")
  .option("-d, --deck <deck>", "Deck name: apply to all cards in this deck")
  .option("--card <id>", "Card id: apply to a single card")
  .action(async (name: string, opts: { deck?: string; card?: string }) => {
    if ((opts.card != null) === (opts.deck != null)) {
      throw new Error("Specify exactly one of --card <id> or --deck <name>.");
    }

    if (opts.card != null) {
      await updateCard(opts.card, { category: name });
      console.log(`  Set category "${name}" on card ${opts.card}`);
      return;
    }

    const deck = await requireDeck(opts.deck!);
    const count = await setDeckCategory(deck.id, name);
    console.log(`  Set category "${name}" on ${count} card(s) in deck ${deck.name}`);
  });

// --- study ---
program
  .command("study")
  .description("Start an interactive study session")
  .option("-d, --deck <deck>", "Only study cards of this deck")
  .option("-c, --category <name>", "Only study cards of this category")
  .option("-l, --limit <n>", "Max review cards (new cards stay capped at 5)", "20")
  .action(async (opts: { deck?: string; category?: string; limit: string }) => {
    const limit = intOption(opts.limit, "--limit", 1);
    const deck = opts.deck != null ? await requireDeck(opts.deck) : undefined;
    const session = await startSession({
      maxNewCardsPerSession: Math.min(limit, 5),
      maxReviewCardsPerSession: limit,
      category: opts.category,
      deckId: deck?.id,
    });

    if (session.queue.length === 0) {
      console.log("\nNo cards due. You're all caught up!");
      return;
    }

    console.log(`\nStudy session started. ${session.queue.length} cards in queue.\n`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => rl.close());
    // Lines are buffered, so piped answers are not lost between prompts. Null
    // once the input is closed (Ctrl+C, Ctrl+D, end of a pipe).
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (prompt: string): Promise<string | null> => {
      process.stdout.write(prompt);
      const line = await lines.next();
      return line.done === true ? null : line.value;
    };

    let reviewed = 0;
    try {
      study: for (;;) {
        const next = await getNextCardOrBlock(session.id);
        if (next == null) break;
        if ("blocked" in next) {
          console.log(`\n${leechBlockError(next.blocked).message}\n`);
          break;
        }

        const { card } = next;
        const position = await getQueuePosition(session.id);
        if (position != null) {
          console.log(`--- Card ${position.position}/${position.total}${position.repeat ? " (again)" : ""} ---`);
        }
        console.log(`\n  ${card.front}\n`);

        if ((await ask("  [Press Enter to reveal answer] ")) === null) break;
        console.log(`\n  ${card.back}\n`);

        let rating: Grade | undefined;
        while (rating === undefined) {
          const answer = await ask("  Rate: (1) Again  (2) Hard  (3) Good  (4) Easy  > ");
          if (answer === null) break study;
          const n = Number(answer.trim());
          if (isGrade(n)) rating = n;
        }

        await submitReview(session.id, card.id, rating);
        reviewed++;
        console.log();
      }
    } finally {
      rl.close();
      // A session that reviewed nothing is discarded at the next start instead.
      if (reviewed > 0) await endSession(session.id);
    }

    console.log(`\n--- Session Complete ---`);
    console.log(`  Cards reviewed: ${reviewed}`);
  });

// --- stats ---
program
  .command("stats")
  .description("Show learning statistics")
  .action(async () => {
    const { streak, retention, maturity, lapses, recentSessions } = await getFullStats();

    console.log(`\n--- Study Statistics ---\n`);
    console.log(`  Streak: ${streak} day${streak !== 1 ? "s" : ""}\n`);

    if (retention.length > 0) {
      console.log("  Retention by deck:");
      for (const r of retention) {
        console.log(
          `    ${r.deckName}: ${(r.avgRetention * 100).toFixed(0)}% (${r.cardCount} cards)`
        );
      }
      console.log();
    }

    if (maturity.length > 0) {
      console.log("  Maturity report:");
      for (const m of maturity) {
        console.log(
          `    ${m.deckName}: ${m.new} new, ${m.learning} learning, ${m.familiar} familiar, ${m.internalized} internalized`
        );
      }
      console.log();
    }

    if (lapses.length > 0) {
      console.log("  Trouble cards (highest lapses):");
      for (const l of lapses.slice(0, 5)) {
        console.log(`    [${l.lapses} lapses] ${l.front.slice(0, 50)} (${l.deckName})`);
      }
      console.log();
    }

    if (recentSessions.length > 0) {
      console.log("  Recent sessions:");
      for (const s of recentSessions) {
        console.log(
          `    ${localDay(s.startTime)}: ${s.cardsReviewed} cards, ${(s.accuracy * 100).toFixed(0)}% accuracy`
        );
      }
      console.log();
    }
  });

// --- calibration ---
program
  .command("calibration")
  .description("True retention over the last 30 days plus a difficulty verdict, as JSON")
  .action(async () => {
    // stdout is a machine interface here — the study repo parses it — so this
    // command prints the report and nothing else.
    console.log(JSON.stringify(await checkCalibration(), null, 2));
  });

// --- overview ---
program
  .command("overview")
  .description("Pending cards and a rough progress picture, as JSON (the Omvida bar panel reads it)")
  .option("--pending <n>", "How many pending cards to list", "8")
  .action(async (opts: { pending: string }) => {
    // stdout is a machine interface, as for `calibration`: the JSON and nothing else.
    const pendingLimit = intOption(opts.pending, "--pending", 0);
    console.log(JSON.stringify(await getOverview({ pendingLimit })));
  });

// --- maturity ---
program
  .command("maturity")
  .description("Show how far each deck has matured (new, learning, familiar, internalized)")
  .action(async () => {
    const maturity = await getMaturityReport();
    if (maturity.length === 0) {
      console.log("No cards yet. Add some cards first.");
      return;
    }

    console.log("\n--- Deck Maturity ---\n");
    for (const m of maturity) {
      const pctInternalized =
        m.total > 0
          ? ((m.internalized / m.total) * 100).toFixed(0)
          : "0";
      console.log(
        `  ${m.deckName}: ${pctInternalized}% internalized (${m.total} total)`
      );
      console.log(
        `    new: ${m.new} | learning: ${m.learning} | familiar: ${m.familiar} | internalized: ${m.internalized}`
      );
    }
    console.log();
  });

// --- import ---
function printImport(result: ImportResult, dryRun: boolean): void {
  const counts = `${result.created} created, ${result.updated} updated, ${result.duplicates} duplicates, ${result.invalid} invalid`;
  console.log(`\n  ${dryRun ? "Would import" : "Imported"}: ${counts}`);
  if (result.invalid > 0) {
    console.log("  Invalid: an empty front, or content the card rules reject (try one with `master cards add`).");
  }
}

program
  .command("import <file>")
  .description("Import cards from Anki (.apkg/.colpkg with scheduling, or .txt plain text)")
  .option("-d, --deck <deck>", "Target deck for .txt (default: the deck the file names); ignored for .apkg")
  .option("--dry-run", "Show what would be imported without writing anything")
  .option("--ours", "On duplicate: keep local version (default)")
  .option("--theirs", "On duplicate: overwrite local with imported version")
  .action(async (file: string, opts: { deck?: string; dryRun?: boolean; ours?: boolean; theirs?: boolean }) => {
    if (opts.ours === true && opts.theirs === true) {
      throw new Error("--ours and --theirs are mutually exclusive");
    }
    const importOpts = { conflict: opts.theirs === true ? "theirs" : "ours", dryRun: opts.dryRun === true } as const;

    if (isApkgPath(file)) {
      printImport(await importApkgFile(file, importOpts), importOpts.dryRun);
      console.log("  Scheduling and review history kept (SM-2 converted to FSRS where Anki had no FSRS data).");
      return;
    }

    const notes = parseAnkiTxt(readFileSync(file, "utf-8"));
    if (notes.length === 0) {
      console.log("No notes found in file.");
      return;
    }
    printImport(await importTxtNotes(notes, { ...importOpts, deck: opts.deck }), importOpts.dryRun);
  });

// --- export ---
program
  .command("export <file>")
  .description("Export cards (.apkg with scheduling, or .txt plain text)")
  .option("-d, --deck <deck>", "Export only this deck (default: all)")
  .action(async (file: string, opts: { deck?: string }) => {
    const deck = opts.deck != null ? await requireDeck(opts.deck) : undefined;

    if (isApkgPath(file)) {
      if (!/\.apkg$/i.test(file)) {
        throw new Error("Export writes a deck package: name the file .apkg (a .colpkg would replace Anki's whole collection)");
      }
      const { cardCount, deckCount } = await exportCardsToApkg(file, deck?.id);
      console.log(`  Exported ${cardCount} cards across ${deckCount} deck(s) to ${file}`);
      console.log("  Scheduling data preserved (FSRS → SM-2 conversion applied).");
      return;
    }

    const result = await exportCardsToAnkiTxt(deck?.id);
    if (result.cardCount === 0) {
      console.log("No cards to export.");
      return;
    }
    writeFileSync(file, result.content, "utf-8");
    console.log(`  Exported ${result.cardCount} cards to ${file}`);
  });

// --- embeddings ---
const embCmd = program.command("embeddings").description("Manage semantic embeddings");

embCmd
  .command("status")
  .description("Show embedding coverage")
  .action(async () => {
    const { total, embedded } = await embeddingCoverage();
    const coverage = total > 0 ? `${((embedded / total) * 100).toFixed(0)}%` : "0%";
    console.log(`\n  Embeddings: ${embedded}/${total} cards (${coverage})\n`);
  });

embCmd
  .command("backfill")
  .description("Generate embeddings for all cards missing them")
  .action(async () => {
    console.log("  Loading embedding model (first run may take 30-60s)...");
    await initEmbeddings();

    const { processed, failed } = await backfillEmbeddings((done, total) => {
      process.stdout.write(`\r  Progress: ${done}/${total}`);
    });

    console.log(`\n  Done: ${processed} embeddings generated, ${failed} failed.\n`);
  });

// --- db:dump / db:restore / db:sync ---
program
  .command("db:dump <file>")
  .description("Export full database as a portable SQL dump")
  .option("--source <path>", "Source DB path (defaults to DATABASE_URL)")
  .action((file: string, opts: { source?: string }) => {
    const src = opts.source ?? databaseFile();
    const result = dumpDatabase(src, file);
    console.log(`  Dumped ${result.rows} rows across ${result.tables} table(s) from ${src} → ${file}`);
  });

program
  .command("db:restore <file>")
  .description("Restore database from a SQL dump")
  .option("--target <path>", "Target DB path (defaults to DATABASE_URL)")
  .option("--force", "Overwrite target if it already exists")
  .action((file: string, opts: { target?: string; force?: boolean }) => {
    const target = opts.target ?? databaseFile();
    const result = restoreDatabase(target, file, { force: opts.force === true });
    console.log(`  Restored ${result.rows} rows across ${result.tables} table(s) from ${file} → ${target}`);
  });

// Every start already syncs the schema (prepareDatabase, below); this says
// what that start did, and is how a script makes a database ready and
// stamped without doing anything else (Omvida's fixture deck).
let schemaPushed = false;
program
  .command("db:sync")
  .description("Bring the database's tables up to prisma/schema.prisma (every start does this too)")
  .action(() => {
    console.log(schemaPushed ? "  Schema pushed (the old database was backed up beside it)" : "  Schema already in sync");
  });

// Run
void prepareDatabase(prisma)
  .then((r) => { schemaPushed = r.schemaPushed; })
  .then(() => program.parseAsync(process.argv))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
