import { Rating, State } from "ts-fsrs";

export { Rating, State };

export type CardMaturity = "new" | "learning" | "familiar" | "internalized";
export type CardType = "guided" | "unguided";

export const KNOWN_CATEGORIES = ["work", "personal"] as const;
export type Category = (typeof KNOWN_CATEGORIES)[number];

export function isKnownCategory(s: string): s is Category {
  return (KNOWN_CATEGORIES as readonly string[]).includes(s);
}

export interface MasterConfig {
  maxNewCardsPerSession: number;
  maxReviewCardsPerSession: number;
  practiceFirstMode: boolean;
}

export const DEFAULT_CONFIG: MasterConfig = {
  maxNewCardsPerSession: 5,
  maxReviewCardsPerSession: 15,
  practiceFirstMode: true,
};

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  reason?: string;
  similarCards?: Array<{
    id: string;
    front: string;
    similarity: number;
  }>;
}

export interface SessionQueueItem {
  cardId: string;
  reason: "due_review" | "new_card" | "unguided_priority";
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
