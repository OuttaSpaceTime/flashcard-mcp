#!/usr/bin/env node

import { Command } from "commander";
import { createClient, setDb } from "../db/client.js";
import { createDeck, listDecks, getDeckStats, getDeckByName, getOrCreateDeck } from "../core/deck-service.js";
import { parseTags } from "../core/types.js";
import { createCard, searchCards, backfillEmbeddings } from "../core/card-service.js";
import { initEmbeddings } from "../core/embeddings.js";
import {
  startSession,
  getNextCard,
  submitReview,
} from "../core/session-service.js";
import {
  getFullStats,
  getMaturityReport,
} from "../core/analytics-service.js";
import type { Grade } from "ts-fsrs";
import { createInterface } from "readline";
import { readFileSync, writeFileSync } from "fs";
import { parseAnkiTxt, importTxtNotes, exportCardsToAnkiTxt } from "../core/anki-io.js";
import { exportToApkg, importFromApkg, importApkgCards } from "../core/anki-apkg.js";
import { dumpDatabase, restoreDatabase } from "../core/db-dump.js";

function defaultDbPath(): string {
  const url = process.env["DATABASE_URL"] ?? "file:./prisma/master.db";
  return url.startsWith("file:") ? url.slice("file:".length) : url;
}

// Initialize Prisma
const prisma = createClient();
setDb(prisma);

const program = new Command();

program
  .name("master")
  .description("Self-improving spaced repetition learning system")
  .version("0.1.0");

// --- init ---
program
  .command("init")
  .description("Initialize database with default topic decks")
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
      try {
        await createDeck(deck.name, deck.description);
        console.log(`  Created deck: ${deck.name}`);
      } catch {
        console.log(`  Deck already exists: ${deck.name}`);
      }
    }

    // Ensure default config exists
    const db = prisma;
    await db.config.upsert({
      where: { id: "default" },
      create: { id: "default" },
      update: {},
    });

    console.log("\nInitialization complete.");
  });

// --- decks ---
program
  .command("decks")
  .description("List all decks with stats")
  .action(async () => {
    const decks = await listDecks();
    if (decks.length === 0) {
      console.log("No decks. Run `master init` to create default decks.");
      return;
    }

    console.log("\nDecks:\n");
    for (const deck of decks) {
      const stats = await getDeckStats(deck.id);
      console.log(`  ${deck.name} (${stats.totalCards} cards)`);
      console.log(
        `    Due: ${stats.dueCards} | New: ${stats.newCards} | Learning: ${stats.learningCards} | Review: ${stats.reviewCards}`
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
  .option("--type <type>", "Card type: guided or unguided", "guided")
  .action(async (deckName: string, opts) => {
    const deck = await getDeckByName(deckName);
    if (!deck) {
      console.error(`Deck "${deckName}" not found. Run \`master decks\` to see available decks.`);
      process.exit(1);
    }

    const { card, duplicateWarning } = await createCard({
      deckId: deck.id,
      front: opts.front,
      back: opts.back,
      tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
      type: opts.type,
      checkDuplicates: true,
    });

    if (duplicateWarning?.isDuplicate) {
      console.log(`\n  Warning: ${duplicateWarning.reason}`);
    }
    console.log(`  Card added to ${deckName}: "${card.front.slice(0, 50)}..."`);
  });

cardsCmd
  .command("list")
  .description("List cards")
  .option("-d, --deck <deck>", "Filter by deck name")
  .option("--due", "Show only due cards")
  .action(async (opts) => {
    const db = prisma;
    let deckId: string | undefined;
    if (opts.deck) {
      const deck = await getDeckByName(opts.deck);
      if (!deck) {
        console.error(`Deck "${opts.deck}" not found.`);
        process.exit(1);
      }
      deckId = deck.id;
    }

    const where: Record<string, unknown> = {};
    if (deckId) where.deckId = deckId;
    if (opts.due) where.due = { lte: new Date() };

    const cards = await db.card.findMany({
      where,
      include: { deck: { select: { name: true } } },
      take: 50,
      orderBy: { due: "asc" },
    });

    if (cards.length === 0) {
      console.log("No cards found.");
      return;
    }

    console.log(`\n${cards.length} cards:\n`);
    for (const card of cards) {
      const state = ["New", "Learning", "Review", "Relearning"][card.state] ?? "?";
      console.log(`  [${state}] ${card.front.slice(0, 60)} (${card.deck.name}) - ${card.maturity}`);
    }
    console.log();
  });

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

// --- study ---
program
  .command("study")
  .description("Start an interactive study session")
  .option("-d, --deck <deck>", "Focus on a specific deck")
  .option("-l, --limit <n>", "Max cards", "20")
  .action(async (opts) => {
    const session = await startSession({
      maxNewCardsPerSession: Math.min(parseInt(opts.limit), 5),
      maxReviewCardsPerSession: parseInt(opts.limit),
    });

    if (session.queue.length === 0) {
      console.log("\nNo cards due. You're all caught up!");
      return;
    }

    console.log(`\nStudy session started. ${session.queue.length} cards in queue.\n`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, resolve));

    let reviewed = 0;
    let card = await getNextCard(session.id);
    while (card != null) {
      reviewed++;
      console.log(`--- Card ${reviewed}/${session.queue.length} ---`);
      console.log(`\n  ${card.front}\n`);

      await ask("  [Press Enter to reveal answer] ");
      console.log(`\n  ${card.back}\n`);

      let rating: Grade | null = null;
      while (rating === null) {
        const input = await ask("  Rate: (1) Again  (2) Hard  (3) Good  (4) Easy  > ");
        const n = parseInt(input.trim());
        if (n >= 1 && n <= 4) rating = n as Grade;
      }

      await submitReview(session.id, card.id, rating);
      console.log();
      card = await getNextCard(session.id);
    }

    console.log(`\n--- Session Complete ---`);
    console.log(`  Cards reviewed: ${reviewed}`);

    rl.close();
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
        const date = s.startTime.toISOString().split("T")[0];
        console.log(
          `    ${date}: ${s.cardsReviewed} cards, ${(s.accuracy * 100).toFixed(0)}% accuracy`
        );
      }
      console.log();
    }
  });

// --- topics ---
program
  .command("topics")
  .description("Show topic maturity report")
  .action(async () => {
    const maturity = await getMaturityReport();
    if (maturity.length === 0) {
      console.log("No cards yet. Add some cards first.");
      return;
    }

    console.log("\n--- Topic Maturity ---\n");
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
program
  .command("import <file>")
  .description("Import cards from Anki (.apkg with scheduling, or .txt plain text)")
  .option("-d, --deck <deck>", "Target deck name (required for .txt, ignored for .apkg)")
  .option("--dry-run", "Show what would be imported without creating cards")
  .option("--ours", "On duplicate: keep local version (default)")
  .option("--theirs", "On duplicate: overwrite local with imported version")
  .action(async (file: string, opts) => {
    if (opts.ours === true && opts.theirs === true) {
      console.error("Error: --ours and --theirs are mutually exclusive");
      process.exit(1);
    }
    const conflict: "ours" | "theirs" = opts.theirs === true ? "theirs" : "ours";
    const action = opts.dryRun === true ? "Would import" : "Imported";

    const isApkg = file.endsWith(".apkg") || file.endsWith(".colpkg");

    if (isApkg) {
      // --- .apkg import (full scheduling) ---
      const imported = await importFromApkg(file);
      let totalCreated = 0;
      let totalUpdated = 0;
      let totalSkipped = 0;

      for (const importDeck of imported.decks) {
        const deck = await getOrCreateDeck(importDeck.name);
        const result = await importApkgCards(
          importDeck.cards,
          deck.id,
          { conflict, dryRun: opts.dryRun }
        );
        totalCreated += result.created;
        totalUpdated += result.updated;
        totalSkipped += result.skipped;
      }

      const updatedPart = totalUpdated > 0 ? ` | Updated: ${totalUpdated}` : "";
      console.log(
        `\n  ${action}: ${totalCreated} cards across ${imported.decks.length} deck(s)${updatedPart} | Skipped: ${totalSkipped}`
      );
      console.log("  Scheduling data preserved (SM-2 → FSRS conversion applied).");
    } else {
      // --- .txt import (plain text, no scheduling) ---
      if (!opts.deck) {
        console.error("--deck is required for .txt imports. Use: master import file.txt -d DeckName");
        process.exit(1);
      }

      const content = readFileSync(file, "utf-8");
      const notes = parseAnkiTxt(content);

      if (notes.length === 0) {
        console.log("No notes found in file.");
        return;
      }

      const deck = await getOrCreateDeck(opts.deck);
      const { created, updated, duplicates, skipped } = await importTxtNotes(
        notes,
        deck.id,
        { conflict, dryRun: opts.dryRun }
      );

      const updatedPart = updated > 0 ? ` | Updated: ${updated}` : "";
      console.log(
        `\n  ${action}: ${created} cards${updatedPart} | Skipped: ${duplicates} | Invalid: ${skipped}`
      );
    }
  });

// --- export ---
program
  .command("export <file>")
  .description("Export cards (.apkg with scheduling, or .txt plain text)")
  .option("-d, --deck <deck>", "Export only this deck (default: all)")
  .action(async (file: string, opts) => {
    const isApkg = file.endsWith(".apkg");
    const db = prisma;

    const where: Record<string, unknown> = {};
    let deckFilter: Awaited<ReturnType<typeof getDeckByName>> | null = null;
    if (opts.deck) {
      deckFilter = await getDeckByName(opts.deck);
      if (!deckFilter) {
        console.error(`Deck "${opts.deck}" not found.`);
        process.exit(1);
      }
      where.deckId = deckFilter.id;
    }

    if (isApkg) {
      // --- .apkg export (full scheduling) ---
      const decks = deckFilter ? [deckFilter] : await db.deck.findMany();

      const exportDecks = [];
      for (const deck of decks) {
        const cards = await db.card.findMany({
          where: { deckId: deck.id },
          include: { reviews: true },
        });

        if (cards.length === 0) continue;

        exportDecks.push({
          deckName: deck.name,
          cards: cards.map((c) => ({
            id: c.id,
            front: c.front,
            back: c.back,
            tags: parseTags(c.tags),
            stability: c.stability,
            difficulty: c.difficulty,
            state: c.state,
            reps: c.reps,
            lapses: c.lapses,
            due: c.due,
            interval: c.interval,
            reviews: c.reviews.map((r) => ({
              rating: r.rating,
              reviewedAt: r.reviewedAt,
              responseMs: r.responseMs ?? 0,
              stability: r.stability,
              difficulty: r.difficulty,
            })),
          })),
        });
      }

      await exportToApkg(file, exportDecks);
      const totalCards = exportDecks.reduce((n, d) => n + d.cards.length, 0);
      console.log(`  Exported ${totalCards} cards across ${exportDecks.length} deck(s) to ${file}`);
      console.log("  Scheduling data preserved (FSRS → SM-2 conversion applied).");
    } else {
      const deckId = opts.deck
        ? (await getDeckByName(opts.deck))?.id
        : undefined;
      const result = await exportCardsToAnkiTxt(deckId);

      if (result.cardCount === 0) {
        console.log("No cards to export.");
        return;
      }

      writeFileSync(file, result.content, "utf-8");
      console.log(`  Exported ${result.cardCount} cards to ${file}`);
    }
  });

// --- embeddings ---
const embCmd = program.command("embeddings").description("Manage semantic embeddings");

embCmd
  .command("status")
  .description("Show embedding coverage")
  .action(async () => {
    const [total, withEmbeddings] = await Promise.all([
      prisma.card.count(),
      prisma.card.count({ where: { embedding: { not: null } } }),
    ]);
    const coverage = total > 0 ? `${((withEmbeddings / total) * 100).toFixed(0)}%` : "0%";
    console.log(`\n  Embeddings: ${withEmbeddings}/${total} cards (${coverage})\n`);
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

// --- db:dump / db:restore ---
program
  .command("db:dump <file>")
  .description("Export full database as a portable SQL dump")
  .option("--source <path>", "Source DB path (defaults to DATABASE_URL)")
  .action((file: string, opts: { source?: string }) => {
    const src = opts.source ?? defaultDbPath();
    const result = dumpDatabase(src, file);
    console.log(`  Dumped ${result.rows} rows across ${result.tables} table(s) from ${src} → ${file}`);
  });

program
  .command("db:restore <file>")
  .description("Restore database from a SQL dump")
  .option("--target <path>", "Target DB path (defaults to DATABASE_URL)")
  .option("--force", "Overwrite target if it already exists")
  .action((file: string, opts: { target?: string; force?: boolean }) => {
    const target = opts.target ?? defaultDbPath();
    const result = restoreDatabase(target, file, { force: opts.force === true });
    console.log(`  Restored ${result.rows} rows across ${result.tables} table(s) from ${file} → ${target}`);
  });

// Run
void program.parseAsync(process.argv).then(() => prisma.$disconnect());
