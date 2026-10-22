/**
 * The one import loop behind both Anki formats (.txt in anki-io.ts, .apkg in
 * anki-apkg.ts): match each item to a card of its deck by front, then create,
 * update or count it, through card-service so content rules, the leech flag
 * and embeddings apply exactly as they do to a card written by hand.
 */

import { dateDiffInDays, State } from "ts-fsrs";
import { getDb } from "../db/client.js";
import { createCard, updateCard, type CarriedSchedule } from "./card-service.js";
import { assertCardContent } from "./content-rules.js";
import { getDeckByName, getOrCreateDeck } from "./deck-service.js";
import { assertCanCreateCard } from "./pressure.js";
import { serializeTags } from "./types.js";

export interface ImportedReview {
  rating: number;
  reviewedAt: Date;
  responseMs: number;
}

export interface ImportItem {
  front: string;
  back: string;
  /** Undefined when the file has no tags: an update then keeps the card's own. */
  tags?: string[];
  /** The schedule the file carries (.apkg); without one a card starts New. */
  schedule?: CarriedSchedule;
  /** Review history, oldest first; written only for a created card. */
  reviews?: ImportedReview[];
}

/** Items bound for one deck, by name; the deck is created when first written to. */
export interface ImportDeck {
  name: string;
  items: ImportItem[];
}

export interface ImportResult {
  created: number;
  /** Existing cards overwritten (conflict "theirs"). */
  updated: number;
  /** Items whose front the deck already has (conflict "ours"), or that repeat an earlier item. */
  duplicates: number;
  /** Items with an empty front, or content the card rules reject. */
  invalid: number;
}

export interface ImportOptions {
  /** On a front the deck already has: keep the card ("ours", default) or overwrite it ("theirs"). */
  conflict?: "ours" | "theirs";
  /** Count what would happen and write nothing, not even a deck. */
  dryRun?: boolean;
}

interface ExistingCard {
  id: string;
  front: string;
  lastReview: Date | null;
}

interface DeckPlan {
  name: string;
  create: ImportItem[];
  update: Array<{ item: ImportItem; card: ExistingCard }>;
}

function isValid(fields: { front?: string; back: string }): boolean {
  try {
    assertCardContent(fields);
    return true;
  } catch {
    return false;
  }
}

/** Sort one deck's items into creates and updates, counting the rest. */
async function planDeck(
  name: string,
  items: ImportItem[],
  conflict: "ours" | "theirs",
  result: ImportResult
): Promise<DeckPlan> {
  const deck = await getDeckByName(name);
  const existing =
    deck == null
      ? []
      : await getDb().card.findMany({
          where: { deckId: deck.id },
          select: { id: true, front: true, lastReview: true },
        });
  const byFront = new Map(existing.map((c) => [c.front, c]));

  const plan: DeckPlan = { name, create: [], update: [] };
  const seen = new Set<string>();
  for (const item of items) {
    if (item.front.trim() === "") {
      result.invalid++;
      continue;
    }
    // The first occurrence of a front in the file is the one that counts.
    if (seen.has(item.front)) {
      result.duplicates++;
      continue;
    }
    seen.add(item.front);

    const card = byFront.get(item.front);
    if (card != null && conflict === "ours") {
      result.duplicates++;
    } else if (card != null) {
      // The front stays as it is, so only the back is held to the rules.
      if (isValid({ back: item.back })) plan.update.push({ item, card });
      else result.invalid++;
    } else if (isValid({ front: item.front, back: item.back })) {
      plan.create.push(item);
    } else {
      result.invalid++;
    }
  }
  return plan;
}

async function applyPlan(plan: DeckPlan): Promise<void> {
  if (plan.create.length === 0 && plan.update.length === 0) return;
  const db = getDb();
  const deck = await getOrCreateDeck(plan.name);

  for (const { item, card } of plan.update) {
    await updateCard(card.id, {
      back: item.back,
      tags: item.tags !== undefined ? serializeTags(item.tags) : undefined,
      // A file without history leaves the card's own last review in place.
      schedule:
        item.schedule != null
          ? { ...item.schedule, lastReview: item.schedule.lastReview ?? card.lastReview }
          : undefined,
    });
  }

  for (const item of plan.create) {
    const { card } = await createCard({
      deckId: deck.id,
      front: item.front,
      back: item.back,
      tags: item.tags,
      schedule: item.schedule,
      skipPressureGate: true,
    });
    const reviews = item.reviews ?? [];
    if (reviews.length === 0) continue;
    await db.review.createMany({
      data: reviews.map((review, i) => ({
        cardId: card.id,
        rating: review.rating,
        responseMs: review.responseMs,
        // Per-review memory state is not carried; the card's current one stands in.
        stability: card.stability,
        difficulty: card.difficulty,
        // Counted as submitReview counts it, so imported history feeds calibration.
        elapsedDays: i === 0 ? 0 : dateDiffInDays(reviews[i - 1].reviewedAt, review.reviewedAt),
        reviewedAt: review.reviewedAt,
      })),
    });
  }
}

/**
 * Import items into their decks. Every item is judged before anything is
 * written, so a refusal leaves the database untouched.
 *
 * Pressure is checked once for the whole batch, and only when it creates New
 * cards: an import is one deliberate act with all the material in hand, and
 * gating each card would abort mid-loop and leave it half-applied. Cards that
 * arrive with a schedule of their own are already-learned material, like a
 * split. Dry runs check too, so they never promise a count a real run would
 * refuse. Updates are never gated, as for updateCard.
 */
export async function importCards(
  decks: ImportDeck[],
  opts: ImportOptions = {}
): Promise<ImportResult> {
  const { conflict = "ours", dryRun = false } = opts;

  // One plan per deck name, so a name given twice still sees its own repeats.
  const itemsByDeck = new Map<string, ImportItem[]>();
  for (const deck of decks) {
    itemsByDeck.set(deck.name, [...(itemsByDeck.get(deck.name) ?? []), ...deck.items]);
  }

  const result: ImportResult = { created: 0, updated: 0, duplicates: 0, invalid: 0 };
  const plans: DeckPlan[] = [];
  for (const [name, items] of itemsByDeck) {
    plans.push(await planDeck(name, items, conflict, result));
  }

  const creates = plans.flatMap((p) => p.create);
  if (creates.some((item) => (item.schedule?.state ?? State.New) === State.New)) {
    await assertCanCreateCard();
  }

  result.created = creates.length;
  result.updated = plans.reduce((n, p) => n + p.update.length, 0);
  if (dryRun) return result;

  for (const plan of plans) await applyPlan(plan);
  return result;
}
