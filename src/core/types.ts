export type CardMaturity = "new" | "learning" | "familiar" | "internalized";
export type CardType = "guided" | "unguided";

/**
 * Session settings a caller may override per session. The saved values and
 * their defaults live in the Config table (schema.prisma).
 */
export interface MasterConfig {
  maxNewCardsPerSession: number;
  maxReviewCardsPerSession: number;
  practiceFirstMode: boolean;
}

/** Card state names, indexed by ts-fsrs `State` (Card.state stores the index). */
export const CARD_STATE_NAMES = ["new", "learning", "review", "relearning"] as const;
export type CardStateName = (typeof CARD_STATE_NAMES)[number];

export interface SessionQueueItem {
  cardId: string;
  reason: "due_review" | "new_card" | "unguided_priority" | "learning_repeat";
}

export interface SessionAdjustment {
  maxCards?: number;
  focusDeck?: string;
  focusCategory?: string;
}

export interface DeckStats {
  id: string;
  name: string;
  description: string | null;
  totalCards: number;
  dueCards: number;
  newCards: number;
  learningCards: number;
  reviewCards: number;
  relearningCards: number;
  dueNew: number;
  dueLearning: number;
  dueReview: number;
  dueRelearning: number;
}

export function parseTags(tagsStr: string): string[] {
  return tagsStr !== "" ? tagsStr.split(",").filter(Boolean) : [];
}

export function serializeTags(tags?: string[]): string {
  return (tags ?? []).join(",");
}
